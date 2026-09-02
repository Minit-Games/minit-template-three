/* ==========================================================================
   The world in Three.js: a ball on a grass plane, lit by one directional
   light, under a sky-coloured fog that hides where the plane ends.

   Every mesh and material is built in code -- no glTF, no textures, nothing
   loaded from a file. That keeps the bundle to the engine plus a few hundred
   bytes and, more importantly, means the game makes no network request at
   all: the sandboxed WebView has none, and the platform rules forbid the
   fetch APIs a loader would use.

   Nothing here knows about the SDK or scoring. It reports what happened
   through the callbacks given to create(), and main.js decides what that is
   worth.
   ========================================================================== */
import {
	WebGLRenderer, Scene, PerspectiveCamera, Fog, Color,
	Mesh, SphereGeometry, PlaneGeometry, MeshStandardMaterial, MeshBasicMaterial,
	DirectionalLight, HemisphereLight, PCFSoftShadowMap, Vector3, Group,
} from 'three';

const GRAVITY = 26;            // world units/s^2
const RESTITUTION = 0.62;
const TAP_IMPULSE = 11.5;
const REST_SPEED = 0.4;
const BALL_RADIUS = 0.62;
const REST_Y = BALL_RADIUS * 0.85;   // nestled into the grass rather than on it
const FOV = 46;

export function createScene(canvas, { onTap, onBounce }) {
	const renderer = new WebGLRenderer({ canvas, antialias: true });
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = PCFSoftShadowMap;

	const scene = new Scene();
	const skyColor = new Color(0x4b9fd6);
	scene.background = skyColor;
	// Fog the far ground into the sky colour, so the plane ends in a horizon
	// rather than a visible edge.
	scene.fog = new Fog(skyColor, 30, 120);

	const camera = new PerspectiveCamera(FOV, 1, 0.1, 400);
	// Where the horizon lands is set by the camera's pitch, not by any fraction
	// of the screen: pitching DOWN raises it, pitching UP lowers it. This puts
	// it a little past 60% of the way down.
	camera.position.set(0, 1.15, 7.5);
	camera.rotation.x = (5 * Math.PI) / 180;

	// Three has used physically-based light units since r155, so these are far
// higher than the pre-r155 numbers most examples still show. Undercooked, the
// ball reads as a near-black blob against a bright field.
scene.add(new HemisphereLight(0xbcd8f0, 0x4f8d34, 2.2));
	const sun = new DirectionalLight(0xfff6e0, 3.4);
	// Over the camera's shoulder and fairly high. Coming from behind the ball
	// leaves the face the player is looking at unlit; coming in too low throws
	// the shadow half a screen away from the ball it belongs to.
	sun.position.set(-3.5, 8, 6);
	sun.castShadow = true;
	sun.shadow.mapSize.set(1024, 1024);
	sun.shadow.camera.near = 0.5;
	sun.shadow.camera.far = 40;
	Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10 });
	sun.shadow.bias = -0.0015;
	scene.add(sun);

	const ground = new Mesh(
		new PlaneGeometry(400, 400),
		new MeshStandardMaterial({ color: 0x4aa032, roughness: 1 }),
	);
	ground.rotation.x = -Math.PI / 2;
	ground.receiveShadow = true;
	scene.add(ground);

	const ball = new Mesh(
		new SphereGeometry(BALL_RADIUS, 32, 24),
		new MeshStandardMaterial({ color: 0xd6323f, roughness: 0.35, metalness: 0.05 }),
	);
	ball.position.set(0, REST_Y, 0);
	ball.castShadow = true;
	scene.add(ball);

	// Clouds: flattened spheres, unlit so they stay bright against the sky.
	const clouds = new Group();
	scene.add(clouds);
	// fog: false, or the fog that hides the end of the ground plane also drains
	// the clouds to the same flat blue and they vanish into the sky.
	const cloudMat = new MeshBasicMaterial({ color: 0xf2f7ff, fog: false });
	for (let i = 0; i < 7; i++) {
		const puff = new Group();
		for (let j = 0; j < 3; j++) {
			const m = new Mesh(new SphereGeometry(1, 12, 8), cloudMat);
			m.position.set((j - 1) * 1.5, Math.random() * 0.3, 0);
			m.scale.set(1.6, 0.7, 1);
			puff.add(m);
		}
		const s = 1.4 + Math.random() * 1.6;
		puff.scale.setScalar(s);
		puff.position.set(-40 + Math.random() * 80, 13 + Math.random() * 10, -50 - Math.random() * 40);
		puff.userData.speed = 0.5 + Math.random() * 0.9;
		clouds.add(puff);
	}

	const velocity = new Vector3();
	let spin = 0;
	let started = false;
	// Whether the ball has settled. Without this the ball never stops bouncing:
	// gravity adds GRAVITY * dt to vy every frame -- about 43 px/s at 60 fps,
	// 130 at the clamped 20 fps floor -- which is already above REST_SPEED, so
	// the settle test passes, then fails again on the very next frame. The
	// result is a permanent micro-bounce that fires the impact sound and throws
	// a burst of grass on every single frame. Raising the threshold cannot fix
	// it, because the number to beat depends on the frame rate; latching the
	// state and switching gravity off does, at any frame rate.
	// Starts true: the ball begins already at rest on the grass, and letting
	// gravity run on frame one fires a bounce -- sound and all -- before the
	// player has touched anything.
	let resting = true;
	let W = 0, H = 0;

	function resize() {
		const vv = window.visualViewport;
		W = Math.round(vv ? vv.width : document.documentElement.clientWidth);
		H = Math.round(vv ? vv.height : document.documentElement.clientHeight);
		// Cap the pixel ratio: a 3x buffer costs real frame time on a phone and
		// buys nothing visible on shapes this simple.
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		renderer.setSize(W, H, false);
		camera.aspect = W / H;
		camera.updateProjectionMatrix();
	}

	/* ---- bounds, derived from the camera ---------------------------------
	   Never a fixed world distance. How much of the world fits across the
	   screen depends on the field of view, on how far the ball is from the
	   camera, and on the aspect ratio of a slot whose shape the host decides. */
	function depthAt(y) {
		const f = new Vector3();
		camera.getWorldDirection(f);
		const p = camera.position;
		return Math.max((0 - p.x) * f.x + (y - p.y) * f.y + (0 - p.z) * f.z, 0.1);
	}

	function halfExtents(y) {
		const depth = depthAt(y);
		const halfH = Math.tan((FOV * Math.PI) / 360) * depth;
		// fov is vertical, so the horizontal extent is that times the aspect --
		// and on a portrait slot the aspect is below 1, which makes horizontal
		// the tighter of the two.
		return { depth, halfH, halfW: halfH * (camera.aspect || 1) };
	}

	/** A little more than the radius: a sphere's silhouette under perspective
	 *  is wider than its centre-plane radius, and a ball stopping flush against
	 *  the border reads as clipping rather than as bouncing off something. */
	function sideLimit(y) {
		return Math.max(halfExtents(y).halfW - BALL_RADIUS * 1.18, BALL_RADIUS * 0.5);
	}

	/** Highest world y still fully visible: the camera's height, plus how far
	 *  the pitched view axis has climbed over that distance, plus the vertical
	 *  half-extent. */
	function ceilingY(y) {
		const { depth, halfH } = halfExtents(y);
		const f = new Vector3();
		camera.getWorldDirection(f);
		const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
		return camera.position.y + f.y * depth + up.y * halfH - BALL_RADIUS * 1.18;
	}

	function step(dt) {
		if (!resting) { velocity.y -= GRAVITY * dt; }
		ball.position.x += velocity.x * dt;
		ball.position.y += velocity.y * dt;
		velocity.x -= velocity.x * 0.4 * dt;

		const limit = sideLimit(ball.position.y);
		if (ball.position.x < -limit) { ball.position.x = -limit; velocity.x = Math.abs(velocity.x) * 0.6; }
		if (ball.position.x > limit) { ball.position.x = limit; velocity.x = -Math.abs(velocity.x) * 0.6; }

		const ceiling = ceilingY(ball.position.y);
		if (ball.position.y > ceiling) { ball.position.y = ceiling; velocity.y = -Math.abs(velocity.y) * 0.5; }

		if (ball.position.y <= REST_Y) {
			ball.position.y = REST_Y;
			if (!resting && -velocity.y > REST_SPEED) {
				const impact = -velocity.y;
				velocity.y = impact * RESTITUTION;
				velocity.x *= 0.86;
				onBounce(impact / 12);
			} else {
				velocity.y = 0;
				velocity.x *= 0.9;
				resting = true;          // a tap wakes it again
			}
		}

		spin += velocity.x * dt * 1.6;
		ball.rotation.z = -spin;

		for (const puff of clouds.children) {
			puff.position.x += puff.userData.speed * dt;
			if (puff.position.x > 45) { puff.position.x = -45; }
		}
	}

	function render() { renderer.render(scene, camera); }

	/** The ball in screen space, for the HUD's flying rewards. */
	function ballScreen() {
		const v = ball.position.clone().project(camera);
		return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
	}

	function ballScreenRadius() {
		const c = ball.position.clone().project(camera);
		const e = ball.position.clone().add(new Vector3(0, BALL_RADIUS, 0)).project(camera);
		return Math.abs(((1 - c.y) / 2) * H - ((1 - e.y) / 2) * H);
	}

	function tryHit(x, y) {
		const s = ballScreen();
		// A fingertip is about 44 px and the ball is a moving target, so the hit
		// area is deliberately larger than the ball looks.
		const reach = Math.max(ballScreenRadius() * 1.5, 30);
		const dx = x - s.x, dy = y - s.y;
		if (dx * dx + dy * dy > reach * reach) { return false; }

		started = true;
		resting = false;
		// Capped by the headroom left: low down it is the full pop, near the top
		// a small hop that keeps the ball hanging where it is easiest to hit.
		const headroom = Math.max(0, ceilingY(ball.position.y) - ball.position.y);
		velocity.y = Math.min(TAP_IMPULSE, Math.sqrt(2 * GRAVITY * headroom));
		velocity.x += (dx / reach) * 3.2;
		onTap();
		return true;
	}

	resize();
	window.addEventListener('resize', resize);
	window.visualViewport?.addEventListener('resize', resize);

	return { step, render, resize, tryHit, ballScreen, ballScreenRadius, get started() { return started; } };
}

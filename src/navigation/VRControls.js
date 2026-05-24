
import * as THREE from "../../libs/three.js/build/three.module.js";
import { EventDispatcher } from "../EventDispatcher.js";
import { XRControllerModelFactory } from '../../libs/three.js/webxr/XRControllerModelFactory.js';
import { Line2 } from "../../libs/three.js/lines/Line2.js";
import { LineGeometry } from "../../libs/three.js/lines/LineGeometry.js";
import { LineMaterial } from "../../libs/three.js/lines/LineMaterial.js";
import { Utils } from "../utils.js";
import { Measure } from "../utils/Measure.js";
import { t, setLanguage, getLanguage, onLanguageChange } from "../i18n.js";

let fakeCam = new THREE.PerspectiveCamera();

// Set to true to calculate surface normal (required for walls/ceilings)
const TORE_NORMAL = true;
// Set to true to display orbital center + orbit circles in VR
const ORBIT_DEBUG = true;
// ────────────────────────────────────────────────────────────────────────────

function toScene(vec, ref) {
	let node = ref.clone();
	node.updateMatrix();
	node.updateMatrixWorld();

	let result = vec.clone().applyMatrix4(node.matrix);

	return result;
};

function computeMove(vrControls, controller) {

	if (!controller || !controller.inputSource || !controller.inputSource.gamepad) {
		return null;
	}

	let pad = controller.inputSource.gamepad;

	let axes = pad.axes;
	// [0,1] are for touchpad, [2,3] for thumbsticks?
	let y = 0;
	if (axes.length === 2) {
		y = axes[1];
	} else if (axes.length === 4) {
		y = axes[3];
	}

	y = Math.sign(y) * (2 * y) ** 2;

	let maxSize = 0;
	for (let pc of viewer.scene.pointclouds) {
		let size = pc.boundingBox.min.distanceTo(pc.boundingBox.max);
		maxSize = Math.max(maxSize, size);
	}
	let multiplicator = Math.pow(maxSize, 0.5) / 2;

	let scale = vrControls.node.scale.x;
	let moveSpeed = viewer.getMoveSpeed();
	let amount = multiplicator * y * (moveSpeed ** 0.5) / scale;


	let rotation = new THREE.Quaternion().setFromEuler(controller.rotation);
	let dir = new THREE.Vector3(0, 0, -1);
	dir.applyQuaternion(rotation);

	let move = dir.clone().multiplyScalar(amount);

	let p1 = vrControls.toScene(controller.position);
	let p2 = vrControls.toScene(controller.position.clone().add(move));

	move = p2.clone().sub(p1);

	return move;
};


const VIEW_UPDATE_MS = 50; // Minimum interval between two setView calls (ms)

class FlyMode {

	constructor(vrControls) {
		this.moveFactor = 1;
		this.dbgLabel = null;
		this._lastViewUpdate = 0;
	}

	start(vrControls) {
		if (!this.dbgLabel) {
			this.dbgLabel = new Potree.TextSprite("abc");
			this.dbgLabel.name = "debug label";
			vrControls.viewer.sceneVR.add(this.dbgLabel);
			this.dbgLabel.visible = false;
		}
	}

	end() {

	}

	update(vrControls, delta) {
		if (vrControls.menuOpen || vrControls.menu2Open) return;

		let primary = vrControls.cPrimary;
		let secondary = vrControls.cSecondary;

		let move1 = computeMove(vrControls, primary);
		let move2 = computeMove(vrControls, secondary);


		if (!move1) {
			move1 = new THREE.Vector3();
		}

		if (!move2) {
			move2 = new THREE.Vector3();
		}

		let move = move1.clone().add(move2);

		move.multiplyScalar(-delta * this.moveFactor);
		vrControls.node.position.add(move);


		let scale = vrControls.node.scale.x;

		let camVR = vrControls.viewer.renderer.xr.getCamera(fakeCam);

		let vrPos = camVR.getWorldPosition(new THREE.Vector3());
		let vrDir = camVR.getWorldDirection(new THREE.Vector3());
		let vrTarget = vrPos.clone().add(vrDir.multiplyScalar(scale));

		let scenePos = toScene(vrPos, vrControls.node);
		let sceneDir = toScene(vrPos.clone().add(vrDir), vrControls.node).sub(scenePos);
		sceneDir.normalize().multiplyScalar(scale);
		let sceneTarget = scenePos.clone().add(sceneDir);

		const now = performance.now();
		if (now - this._lastViewUpdate > VIEW_UPDATE_MS) {
			vrControls.viewer.scene.view.setView(scenePos, sceneTarget);
			this._lastViewUpdate = now;
		}

		if (Potree.debug.message) {
			this.dbgLabel.visible = true;
			this.dbgLabel.setText(Potree.debug.message);
			this.dbgLabel.scale.set(0.1, 0.1, 0.1);
			this.dbgLabel.position.copy(primary.position);
		}
	}
};

class TeleportMode {
	constructor() {
		this.controller = null;
		this.line = null;
		this.marker = null;
		this.intersection = null;

		this.teleportOffset = 1.8;  // height of the head above the landing point (VR meters)
		this.lastHitTime = 0;
		this.hitTimeout = 1000;     // ms without hit → gray laser
		this.lastPickedWorld = null;
		this.currentQuat = new THREE.Quaternion();

		this._lastViewUpdate = 0;   // LOD sync
	}

	start(vrControls) {
		this.controller = vrControls.cPrimary;
		if (!this.line) {
			this.line = Potree.Utils.debugLine(
				vrControls.viewer.sceneVR,
				new THREE.Vector3(0, 0, 0),
				new THREE.Vector3(0, 0, 0),
				0x00ff00,
			);
			this.line.node.material.depthTest = false;
			this.line.node.material.transparent = true;

			const sg = new THREE.TorusGeometry(0.3, 0.02, 16, 32);
			const sm = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
			this.marker = new THREE.Mesh(sg, sm);
			vrControls.viewer.sceneVR.add(this.marker);

			// Arrow parented to marker — always points along local +Z (= surface normal).
			// Orientation + color change per surface type; no need to touch the arrow direction.
			this._arrow = new THREE.ArrowHelper(
				new THREE.Vector3(0, 0, 1),
				new THREE.Vector3(0, 0, 0.05), // slight offset to avoid z-fighting with torus face
				0.5,   // length (local units × marker scale 0.15 = ~7.5 cm world)
				0x00ff00,
				0.2,   // head length
				0.1    // head width
			);
			this.marker.add(this._arrow);
		}
		this.line.node.visible = true;
		this.marker.visible = false;
		this.marker.matrixAutoUpdate = true;
	}

	end(vrControls) {
		// Hide laser and marker when exiting the mode
		if (this.line) this.line.node.visible = false;
		if (this.marker) this.marker.visible = false;
		this.lastPickedWorld = null;
		this.lastHitTime = 0;
		this.intersection = null;
	}

		// Execute teleport to the current target (called by onTriggerStart)
	executeTeleport(vrControls) {
		if (!this.intersection) return;
		const camVR = vrControls.viewer.renderer.xr.getCamera(fakeCam);
		const headWorldPos = vrControls.toScene(camVR.position);
		const diff = this.intersection.clone().sub(headWorldPos);
		vrControls._fadeDest = vrControls.node.position.clone().add(diff);
		vrControls._fadeState = 'out';
		vrControls._fadeT = 0;
		this.lastPickedWorld = null;
		this.lastHitTime = 0;
		this.intersection = null;
	}

	update(vrControls, delta) {
		// Keep Potree LOD in sync with head position (pitch/yaw must also be updated, not just position)
		const nowMs = performance.now();
		if (nowMs - this._lastViewUpdate > VIEW_UPDATE_MS) {
			this._lastViewUpdate = nowMs;
			const camVRlod = vrControls.viewer.renderer.xr.getCamera(fakeCam);
			const vrPosLod = camVRlod.getWorldPosition(new THREE.Vector3());
			const vrDirLod = camVRlod.getWorldDirection(new THREE.Vector3());
			const scaleLod = vrControls.node.scale.x;
			const scenePosLod = toScene(vrPosLod, vrControls.node);
			const sceneDirLod = toScene(vrPosLod.clone().add(vrDirLod), vrControls.node).sub(scenePosLod).normalize();
			vrControls.viewer.scene.view.setView(scenePosLod, scenePosLod.clone().add(sceneDirLod.multiplyScalar(scaleLod)));
		}

		const vrNode = vrControls.node;
		const originWorld = vrControls.toScene(this.controller.position);
		const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.controller.quaternion);
		const directionWorld = forward.clone().applyQuaternion(vrNode.quaternion).normalize();
		const ray = new THREE.Ray(originWorld, directionWorld);
		const pointclouds = vrControls.viewer.scene.pointclouds;

		const now = performance.now();

		const hit = Utils.getVRPointCloudIntersectionCPU(ray, pointclouds, { projectOnRay: true, wideRadius: true });
		if (hit && hit.position) {
			this.lastPickedWorld = hit.position.clone();
			this.lastHitTime = now;
		}
		// Hide laser only after hitTimeout ms without any valid hit
		const hasRecentHit = this.lastPickedWorld && (now - this.lastHitTime < this.hitTimeout);
		const scale = vrControls.node.scale.x;

		if (!hasRecentHit) {
			// Show a grey "searching" laser pointing forward at 5m so the user has feedback
			this.intersection = null;
			this.marker.visible = false;
			this.line.node.visible = true;
			const searchEnd = this.controller.position.clone().add(forward.clone().multiplyScalar(5));
			this.line.set(this.controller.position, searchEnd);
			if (this.line.node.material) this.line.node.material.color.set(0x888888);
			return;
		}

		this.line.node.visible = true;

		const COLOR_FLOOR = 0x00ff44;
		const COLOR_WALL = 0x44aaff;
		const COLOR_CEILING = 0xff3300;

		// Laser endpoint in VR — recalculated every frame so the line follows the controller in real-time
		const depthVR = originWorld.distanceTo(this.lastPickedWorld) / scale;
		const laserEndVR = this.controller.position.clone().add(forward.clone().multiplyScalar(depthVR));

		// dzRatio : vertical component (scene Z = up) of the controller→hit vector, normalized
		const toHit = this.lastPickedWorld.clone().sub(originWorld);
		const totalDist = toHit.length();
		const dzRatio = totalDist > 0 ? toHit.z / totalDist : 0;

		if (dzRatio < -0.15) {
			// Floor: flat torus (normal = scene +Z), arrow pointing up
			this.intersection = this.lastPickedWorld.clone().add(
				new THREE.Vector3(0, 0, 1).multiplyScalar(this.teleportOffset * scale)
			);
			this.currentQuat.identity();
			this.marker.material.color.setHex(COLOR_FLOOR);
			if (this._arrow) this._arrow.setColor(COLOR_FLOOR);
		} else if (dzRatio > 0.15) {
			// Ceiling: land at teleportOffset below the impact point (inverted torus, arrow pointing down)
			this.intersection = this.lastPickedWorld.clone().add(
				new THREE.Vector3(0, 0, -1).multiplyScalar(this.teleportOffset * scale)
			);
			this.currentQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
			this.marker.material.color.setHex(COLOR_CEILING);
			if (this._arrow) this._arrow.setColor(COLOR_CEILING);
		} else {
			// Wall: vertical torus (normal = horizontal towards the inside), arrow pointing towards the room
			const wallNormal = new THREE.Vector3(-toHit.x, -toHit.y, 0).normalize();
			this.intersection = this.lastPickedWorld.clone().add(
				wallNormal.multiplyScalar(this.teleportOffset * scale)
			);
			this.currentQuat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), wallNormal);
			this.marker.material.color.setHex(COLOR_WALL);
			if (this._arrow) this._arrow.setColor(COLOR_WALL);
		}

		const vrNodeQuat = new THREE.Quaternion();
		vrNode.matrixWorld.decompose(new THREE.Vector3(), vrNodeQuat, new THREE.Vector3());
		this.marker.visible = true;
		this.marker.quaternion.copy(vrNodeQuat.clone().invert().multiply(this.currentQuat));

		this.marker.position.copy(vrControls.toVR(this.lastPickedWorld));
		this.marker.scale.setScalar(Math.max(0.15, depthVR * 0.05));
		this.line.set(this.controller.position, laserEndVR);
		if (this.line.node.material) this.line.node.material.color.set(0x00ff00);
	}
}

class TranslationMode {

	constructor() {
		this.controller = null;
		this.startPos = null;
		this.debugLine = null;
	}

	start(vrControls) {
		this.controller = vrControls.triggered.values().next().value;
		this.startPos = vrControls.node.position.clone();
	}

	end(vrControls) {

	}

	update(vrControls, delta) {

		let start = this.controller.start.position;
		let end = this.controller.position;

		start = vrControls.toScene(start);
		end = vrControls.toScene(end);

		let diff = end.clone().sub(start);
		diff.set(-diff.x, -diff.y, -diff.z);

		let pos = new THREE.Vector3().addVectors(this.startPos, diff);

		vrControls.node.position.copy(pos);
	}

};

class OrbitMode {
	constructor() {
		this.rotationSpeed = 1.5;
		this.zoomSpeed = 0.8;
		this.orbitRadius = 1;
		this.center = new THREE.Vector3();
		this._totalYaw = 0;
		this._totalPitch = 0;
	}

	start(vrControls) {
		// Orbital center = point of the cloud targeted by VR camera (CPU ray cast)
		const cam = vrControls.viewer.renderer.xr.getCamera(fakeCam);
		const vrPos = cam.getWorldPosition(new THREE.Vector3());
		const vrDir = cam.getWorldDirection(new THREE.Vector3());
		const scenePos = vrControls.toScene(vrPos);
		const sceneDir = vrDir.clone().applyQuaternion(vrControls.node.quaternion).normalize();

		const ray = new THREE.Ray(scenePos, sceneDir);
		const hit = Utils.getVRPointCloudIntersectionCPU(
			ray, vrControls.viewer.scene.pointclouds, { projectOnRay: true, wideRadius: true }
		);

		if (hit && hit.position) {
			this.center.copy(hit.position);
		} else {
			this.center.set(0, 0, 0);
			const pointclouds = vrControls.viewer.scene.pointclouds;
			if (pointclouds.length > 0) {
				const combined = new THREE.Box3();
				for (const pc of pointclouds) {
					combined.union(pc.boundingBox.clone().applyMatrix4(pc.matrixWorld));
				}
				combined.getCenter(this.center);
			}
		}

		this.orbitRadius = scenePos.distanceTo(this.center);
		this._totalYaw = 0;
		this._totalPitch = 0;
	}

	end(vrControls) {
		this._hideDebugOrbit();

		const node = vrControls.node;
		const c = this.center;

		// 1. If no pitch has been applied, nothing to correct
		if (Math.abs(this._totalPitch) > 0.0001) {

			// 2. Retrieve the pitch axis exactly as in your update
			const camRight = new THREE.Vector3().setFromMatrixColumn(node.matrixWorld, 0);
			camRight.z = 0;
			if (camRight.lengthSq() < 0.0001) camRight.set(1, 0, 0);
			else camRight.normalize();

			// 3. Calculate the cancellation matrix (we rotate by -_totalPitch)
			const mToOrigin = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z);
			const mToCenter = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z);
			const mUnPitch = new THREE.Matrix4().makeRotationAxis(camRight, -this._totalPitch);

			// T(c) * R_inverse * T(-c)
			const mCorrection = new THREE.Matrix4()
				.multiply(mToCenter)
				.multiply(mUnPitch)
				.multiply(mToOrigin);

			// 4. Application and decomposition
			node.applyMatrix4(mCorrection);
			node.matrix.decompose(node.position, node.quaternion, node.scale);
			node.updateMatrixWorld();
			this._totalPitch = 0;
		}

		// 6. Final synchronization of Potree LOD engine
		const camVR = vrControls.viewer.renderer.xr.getCamera(fakeCam);
		const camScenePos = vrControls.toScene(camVR.getWorldPosition(new THREE.Vector3()));
		vrControls.viewer.scene.view.setView(camScenePos, c);
	}

	_updateDebugOrbit(vrControls, axes) {
		const sceneVR = vrControls.viewer.sceneVR;
		const SEGS = 64;

		if (!this._debugObjects) {
			this._debugObjects = {};

			// Red sphere at the center of the orbit
			const sphereGeo = new THREE.SphereBufferGeometry(0.03, 16, 8);
			const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff2200, depthTest: false });
			this._debugObjects.centerSphere = new THREE.Mesh(sphereGeo, sphereMat);
			this._debugObjects.centerSphere.renderOrder = 999;
			sceneVR.add(this._debugObjects.centerSphere);

			// Utility function to create a LineLoop of SEGS points
			const buildLoop = (color) => {
				const pts = new Float32Array(SEGS * 3);
				const geo = new THREE.BufferGeometry();
				geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
				const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
				const loop = new THREE.LineLoop(geo, mat);
				loop.renderOrder = 998;
				sceneVR.add(loop);
				return loop;
			};
			// 3 circles: horizontal plane (XY scene = Z-up), XZ plane, YZ plane
			this._debugObjects.circleXY = buildLoop(0x00ffff);
			this._debugObjects.circleXZ = buildLoop(0x00ff88);
			this._debugObjects.circleYZ = buildLoop(0xff88ff);

			// Yellow line center → camera
			const lineGeo = new THREE.BufferGeometry();
			lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
			const lineMat = new THREE.LineBasicMaterial({ color: 0xffff00, depthTest: false });
			this._debugObjects.camLine = new THREE.Line(lineGeo, lineMat);
			this._debugObjects.camLine.renderOrder = 999;
			sceneVR.add(this._debugObjects.camLine);

			// Text label (real-time data)
			this._debugObjects.label = new Potree.TextSprite('...');
			this._debugObjects.label.scale.set(0.12, 0.12, 0.12);
			sceneVR.add(this._debugObjects.label);
		}

		// Make everything visible
		for (const obj of Object.values(this._debugObjects)) obj.visible = true;

		const vrCenter = vrControls.toVR(this.center);
		this._debugObjects.centerSphere.position.copy(vrCenter);

		// Update circles: points generated in scene space, converted to VR
		const updateCircle = (loop, planeFunc) => {
			const posAttr = loop.geometry.getAttribute('position');
			const arr = posAttr.array;
			for (let i = 0; i < SEGS; i++) {
				const t = (i / SEGS) * Math.PI * 2;
				const vrPt = vrControls.toVR(planeFunc(t));
				arr[i * 3] = vrPt.x;
				arr[i * 3 + 1] = vrPt.y;
				arr[i * 3 + 2] = vrPt.z;
			}
			posAttr.needsUpdate = true;
		};

		const r = this.orbitRadius;
		const cx = this.center.x, cy = this.center.y, cz = this.center.z;
		updateCircle(this._debugObjects.circleXY, (t) =>
			new THREE.Vector3(cx + r * Math.cos(t), cy + r * Math.sin(t), cz));
		updateCircle(this._debugObjects.circleXZ, (t) =>
			new THREE.Vector3(cx + r * Math.cos(t), cy, cz + r * Math.sin(t)));
		updateCircle(this._debugObjects.circleYZ, (t) =>
			new THREE.Vector3(cx, cy + r * Math.cos(t), cz + r * Math.sin(t)));

		// Line center → VR camera position
		const camVR = vrControls.viewer.renderer.xr.getCamera(fakeCam);
		const vrCamPos = camVR.getWorldPosition(new THREE.Vector3());
		const linePosAttr = this._debugObjects.camLine.geometry.getAttribute('position');
		const la = linePosAttr.array;
		la[0] = vrCenter.x; la[1] = vrCenter.y; la[2] = vrCenter.z;
		la[3] = vrCamPos.x; la[4] = vrCamPos.y; la[5] = vrCamPos.z;
		linePosAttr.needsUpdate = true;

		// Real-time data label — positioned 0.5m in front and 0.15m below the VR camera
		const camDir = camVR.getWorldDirection(new THREE.Vector3());
		const labelPos = vrCamPos.clone()
			.add(camDir.multiplyScalar(0.5))
			.add(new THREE.Vector3(0, -0.15, 0));
		this._debugObjects.label.position.copy(labelPos);

		const toDeg = (r) => (r * 180 / Math.PI).toFixed(1);
		const { axisLX = 0, axisLY = 0, axisRY = 0 } = axes || {};
		const nodeS = vrControls.node.scale.x;
		this._debugObjects.label.setText(
			`yaw:   ${toDeg(this._totalYaw)}°\n` +
			`pitch: ${toDeg(this._totalPitch)}°\n` +
			`radius:${this.orbitRadius.toFixed(3)}\n` +
			`scale: ${nodeS.toFixed(4)}\n` +
			`LX:${axisLX.toFixed(2)} LY:${axisLY.toFixed(2)} RY:${axisRY.toFixed(2)}`
		);
	}

	_hideDebugOrbit() {
		if (!this._debugObjects) return;
		for (const obj of Object.values(this._debugObjects)) obj.visible = false;
	}

	update(vrControls, delta) {
		const node = vrControls.node;
		if (vrControls.menuOpen || vrControls.menu2Open) return;
		let axisLX = 0, axisLY = 0, axisRY = 0;

		if (vrControls.cSecondary &&
			vrControls.cSecondary.inputSource &&
			vrControls.cSecondary.inputSource.gamepad) {
			const gpL = vrControls.cSecondary.inputSource.gamepad;
			axisLX = Math.abs(gpL.axes[2] || 0) > 0.1 ? gpL.axes[2] : 0;
			axisLY = Math.abs(gpL.axes[3] || 0) > 0.1 ? gpL.axes[3] : 0;
		}

		if (vrControls.cPrimary &&
			vrControls.cPrimary.inputSource &&
			vrControls.cPrimary.inputSource.gamepad) {
			const gpR = vrControls.cPrimary.inputSource.gamepad;
			axisRY = Math.abs(gpR.axes[3] || 0) > 0.1 ? gpR.axes[3] : 0;
		}

		if (axisLX === 0 && axisLY === 0 && axisRY === 0) {
			if (ORBIT_DEBUG) this._updateDebugOrbit(vrControls, { axisLX, axisLY, axisRY });
			return;
		}

		const c = this.center;
		const mToOrigin = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z);
		const mToCenter = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z);

		// Final combined matrix (identity initially)
		let mCombined = new THREE.Matrix4();

		// ── Zoom : T(c) · Scale(1/s) · T(-c) ──────────────────────────────
		if (axisRY !== 0) {
			const s = Math.max(0.05, 1 + axisRY * this.zoomSpeed * delta);
			const mZoom = new THREE.Matrix4()
				.multiply(mToCenter)
				.multiply(new THREE.Matrix4().makeScale(1 / s, 1 / s, 1 / s))
				.multiply(mToOrigin);
			mCombined.premultiply(mZoom);
		}

		// ── Incremental rotation: T(c) · Pitch · Yaw · T(-c) ────────────
		if (axisLX !== 0 || axisLY !== 0) {
			const deltaYaw = -axisLX * this.rotationSpeed * delta;
			const rawDeltaPitch = -axisLY * this.rotationSpeed * delta;
			const clampedTotal = Math.max(-Math.PI / 2 * 0.95, Math.min(Math.PI / 2 * 0.95, this._totalPitch + rawDeltaPitch));
			const deltaPitch = clampedTotal - this._totalPitch;

			const mYaw = new THREE.Matrix4().makeRotationZ(deltaYaw);

			// Pitch axis = node X column projected horizontally
			const camRight = new THREE.Vector3().setFromMatrixColumn(node.matrixWorld, 0);
			camRight.z = 0;
			if (camRight.lengthSq() < 0.0001) camRight.set(1, 0, 0);
			else camRight.normalize();
			const mPitch = new THREE.Matrix4().makeRotationAxis(camRight, deltaPitch);

			const mRot = new THREE.Matrix4()
				.multiply(mToCenter)
				.multiply(mPitch)
				.multiply(mYaw)
				.multiply(mToOrigin);
			mCombined.premultiply(mRot);

			this._totalYaw += deltaYaw;
			this._totalPitch = clampedTotal;
		}

		node.applyMatrix4(mCombined);
		node.matrix.decompose(node.position, node.quaternion, node.scale);
		node.updateMatrixWorld();

		vrControls.viewer.setMoveSpeed(node.scale.x);

		// Sync LOD camera
		const camVR = vrControls.viewer.renderer.xr.getCamera(fakeCam);
		const camScenePos = vrControls.toScene(camVR.getWorldPosition(new THREE.Vector3()));
		vrControls.viewer.scene.view.setView(camScenePos, this.center);
		this.orbitRadius = camScenePos.distanceTo(c);

		if (ORBIT_DEBUG) this._updateDebugOrbit(vrControls, { axisLX, axisLY, axisRY });
		else this._hideDebugOrbit();
	}
}

class RotScaleMode {

	constructor() {
		this.line = null;
		this.startState = null;
	}

	start(vrControls) {
		if (!this.line) {
			this.line = Potree.Utils.debugLine(
				vrControls.viewer.sceneVR,
				new THREE.Vector3(0, 0, 0),
				new THREE.Vector3(0, 0, 0),
				0xffff00,
			);

			this.dbgLabel = new Potree.TextSprite("abc");
			this.dbgLabel.scale.set(0.1, 0.1, 0.1);
			vrControls.viewer.sceneVR.add(this.dbgLabel);
		}

		this.line.node.visible = true;

		this.startState = vrControls.node.clone();
	}

	end(vrControls) {
		this.line.node.visible = false;
		this.dbgLabel.visible = false;
	}

	update(vrControls, delta) {

		let start_c1 = vrControls.cPrimary.start.position.clone();
		let start_c2 = vrControls.cSecondary.start.position.clone();
		let start_center = start_c1.clone().add(start_c2).multiplyScalar(0.5);
		let start_c1_c2 = start_c2.clone().sub(start_c1);
		let end_c1 = vrControls.cPrimary.position.clone();
		let end_c2 = vrControls.cSecondary.position.clone();
		let end_center = end_c1.clone().add(end_c2).multiplyScalar(0.5);
		let end_c1_c2 = end_c2.clone().sub(end_c1);

		let d1 = start_c1_c2.length();
		let d2 = end_c1_c2.length();

		let angleStart = new THREE.Vector2(start_c1_c2.x, start_c1_c2.z).angle();
		let angleEnd = new THREE.Vector2(end_c1_c2.x, end_c1_c2.z).angle();
		let angleDiff = angleEnd - angleStart;

		let scale = d2 / d1;

		let node = this.startState.clone();
		node.updateMatrix();
		node.matrixAutoUpdate = false;

		let mToOrigin = new THREE.Matrix4().makeTranslation(...toScene(start_center, this.startState).multiplyScalar(-1).toArray());
		let mToStart = new THREE.Matrix4().makeTranslation(...toScene(start_center, this.startState).toArray());
		let mRotate = new THREE.Matrix4().makeRotationZ(angleDiff);
		let mScale = new THREE.Matrix4().makeScale(1 / scale, 1 / scale, 1 / scale);

		node.applyMatrix4(mToOrigin);
		node.applyMatrix4(mRotate);
		node.applyMatrix4(mScale);
		node.applyMatrix4(mToStart);

		let oldScenePos = toScene(start_center, this.startState);
		let newScenePos = toScene(end_center, node);
		let toNew = oldScenePos.clone().sub(newScenePos);
		let mToNew = new THREE.Matrix4().makeTranslation(...toNew.toArray());
		node.applyMatrix4(mToNew);

		node.matrix.decompose(node.position, node.quaternion, node.scale);

		vrControls.node.position.copy(node.position);
		vrControls.node.quaternion.copy(node.quaternion);
		vrControls.node.scale.copy(node.scale);
		vrControls.node.updateMatrix();

		{
			let scale = vrControls.node.scale.x;
			let camVR = vrControls.viewer.renderer.xr.getCamera(fakeCam);

			let vrPos = camVR.getWorldPosition(new THREE.Vector3());
			let vrDir = camVR.getWorldDirection(new THREE.Vector3());
			let vrTarget = vrPos.clone().add(vrDir.multiplyScalar(scale));

			let scenePos = toScene(vrPos, this.startState);
			let sceneDir = toScene(vrPos.clone().add(vrDir), this.startState).sub(scenePos);
			sceneDir.normalize().multiplyScalar(scale);
			let sceneTarget = scenePos.clone().add(sceneDir);

			vrControls.viewer.scene.view.setView(scenePos, sceneTarget);
			vrControls.viewer.setMoveSpeed(scale);
		}

		{ // update "GUI"
			this.line.set(end_c1, end_c2);

			let scale = vrControls.node.scale.x;
			this.dbgLabel.visible = true;
			this.dbgLabel.position.copy(end_center);
			this.dbgLabel.setText(`scale: 1 : ${scale.toFixed(2)}`);
			this.dbgLabel.scale.set(0.05, 0.05, 0.05);
		}

	}

};


export class VRControls extends EventDispatcher {

	constructor(viewer) {
		super(viewer);

		this.viewer = viewer;

		viewer.addEventListener("vr_start", this.onStart.bind(this));
		viewer.addEventListener("vr_end", this.onEnd.bind(this));

		this.node = new THREE.Object3D();
		this.node.up.set(0, 0, 1);
		this.triggered = new Set();
		this.navigationState = 'EXPLORE'; // mode par défaut
		this.subState = 'FLY';

		// Fade-to-black teleport state
		this._fadeState = null;
		this._fadeT = 0;
		this._fadeDest = null;
		this._fadeMesh = null;

		// Références i18n pour mise à jour dynamique de la langue
		this._langLabels = [];
		onLanguageChange(() => this._applyLang());

		let xr = viewer.renderer.xr;

		{ // lights

			const light = new THREE.PointLight(0xffffff, 5, 0, 1);
			light.position.set(0, 2, 0);
			this.viewer.sceneVR.add(light)
		}

		this.menu = null;

		const controllerModelFactory = new XRControllerModelFactory();

		let sg = new THREE.SphereGeometry(1, 32, 32);
		let sm = new THREE.MeshNormalMaterial();

		{ // setup primary controller
			let controller = xr.getController(0);

			let grip = xr.getControllerGrip(0);
			grip.name = "grip(0)";

			// ADD CONTROLLERMODEL
			grip.add(controllerModelFactory.createControllerModel(grip));
			this.viewer.sceneVR.add(grip);

			// ADD SPHERE
			let sphere = new THREE.Mesh(sg, sm);
			sphere.scale.set(0.005, 0.005, 0.005);

			controller.add(sphere);
			controller.visible = true;
			this.viewer.sceneVR.add(controller);

			{ // ADD LINE

				let lineGeometry = new LineGeometry();

				lineGeometry.setPositions([
					0, 0, -0.15,
					0, 0, 0.05,
				]);

				let lineMaterial = new LineMaterial({
					color: 0xff0000,
					linewidth: 2,
					resolution: new THREE.Vector2(1000, 1000),
				});

				const line = new Line2(lineGeometry, lineMaterial);

				controller.add(line);
			}


			controller.addEventListener('connected', function (event) {
				const xrInputSource = event.data;
				controller.inputSource = xrInputSource;
				if (xrInputSource.handedness === 'left') this._leftCtrl = controller;
				else if (xrInputSource.handedness === 'right') this._rightCtrl = controller;
				this.initMenu(controller);
			}.bind(this));

			controller.addEventListener('selectstart', () => { this.onTriggerStart(controller) });
			controller.addEventListener('selectend', () => { this.onTriggerEnd(controller) });
			controller.addEventListener('squeezestart', () => { this.onSqueezeStart(controller) });

			controller._grip = grip;
			this.cPrimary = controller;

		}

		{ // setup secondary controller
			let controller = xr.getController(1);

			let grip = xr.getControllerGrip(1);

			// ADD CONTROLLER MODEL
			let model = controllerModelFactory.createControllerModel(grip);
			grip.add(model);
			this.viewer.sceneVR.add(grip);

			// ADD SPHERE
			let sphere = new THREE.Mesh(sg, sm);
			sphere.scale.set(0.005, 0.005, 0.005);
			controller.add(sphere);
			controller.visible = true;
			this.viewer.sceneVR.add(controller);

			{ // ADD LINE

				let lineGeometry = new LineGeometry();

				lineGeometry.setPositions([
					0, 0, -0.15,
					0, 0, 0.05,
				]);

				let lineMaterial = new LineMaterial({
					color: 0xff0000,
					linewidth: 2,
					resolution: new THREE.Vector2(1000, 1000),
				});

				const line = new Line2(lineGeometry, lineMaterial);

				controller.add(line);
			}

			controller.addEventListener('connected', (event) => {
				const xrInputSource = event.data;
				controller.inputSource = xrInputSource;
				if (xrInputSource.handedness === 'left') this._leftCtrl = controller;
				else if (xrInputSource.handedness === 'right') this._rightCtrl = controller;
				this.initMenu2(controller);
			});

			controller.addEventListener('selectstart', () => { this.onTriggerStart(controller) });
			controller.addEventListener('selectend', () => { this.onTriggerEnd(controller) });
			controller.addEventListener('squeezestart', () => { this.onSqueezeStart(controller) });

			controller._grip = grip;
			this.cSecondary = controller;
		}

		this.mode_fly = new FlyMode();
		this.mode_translate = new TranslationMode();
		this.mode_rotScale = new RotScaleMode();
		this.mode_teleport = new TeleportMode();
		this.mode_orbit = new OrbitMode();

		this.setMode(this.mode_fly);
		this.initControllerHints();
	}

	createSlider(label, min, max) {

		let sg = new THREE.SphereGeometry(1, 8, 8);
		let cg = new THREE.CylinderGeometry(1, 1, 1, 8);
		let matHandle = new THREE.MeshBasicMaterial({ color: 0xff0000 });
		let matScale = new THREE.MeshBasicMaterial({ color: 0xff4444 });
		let matValue = new THREE.MeshNormalMaterial();

		let node = new THREE.Object3D("slider");
		let nLabel = new Potree.TextSprite(`${label}: 0`);
		let nMax = new THREE.Mesh(sg, matHandle);
		let nMin = new THREE.Mesh(sg, matHandle);
		let nValue = new THREE.Mesh(sg, matValue);
		let nScale = new THREE.Mesh(cg, matScale);

		nLabel.scale.set(0.2, 0.2, 0.2);
		nLabel.position.set(0, 0.35, 0);

		nMax.scale.set(0.02, 0.02, 0.02);
		nMax.position.set(0, 0.25, 0);

		nMin.scale.set(0.02, 0.02, 0.02);
		nMin.position.set(0, -0.25, 0);

		nValue.scale.set(0.02, 0.02, 0.02);
		nValue.position.set(0, 0, 0);

		nScale.scale.set(0.005, 0.5, 0.005);

		node.add(nLabel);
		node.add(nMax);
		node.add(nMin);
		node.add(nValue);
		node.add(nScale);

		return node;
	}
	createTextMesh(text, width, height, fontSize) {
		fontSize = fontSize || 32;
		const canvas = document.createElement('canvas');
		canvas.width = width || 256;
		canvas.height = height || 64;
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = 'rgba(0,0,0,0)';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = 'white';
		ctx.font = fontSize + 'px monospace';
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';
		ctx.fillText(text, 8, canvas.height / 2);

		const texture = new THREE.CanvasTexture(canvas);
		const geo = new THREE.PlaneGeometry(
			canvas.width / 1000,
			canvas.height / 1000
		);
		const mat = new THREE.MeshBasicMaterial({
			map: texture, transparent: true, side: THREE.DoubleSide
		});
		const mesh = new THREE.Mesh(geo, mat);
		mesh._canvas = canvas;
		mesh._ctx = ctx;
		mesh._fontSize = fontSize;

		// Méthode pour mettre à jour le texte
		mesh.setText = function (newText) {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.fillStyle = 'rgba(0,0,0,0)';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.fillStyle = 'white';
			ctx.font = fontSize + 'px monospace';
			ctx.textAlign = 'left';
			ctx.textBaseline = 'middle';
			ctx.fillText(newText, 8, canvas.height / 2);
			texture.needsUpdate = true;
		};

		return mesh;
	}
	createInfo() {

		let texture = new THREE.TextureLoader().load(`${Potree.resourcePath}/images/vr_controller_help.jpg`);
		let plane = new THREE.PlaneBufferGeometry(1, 1, 1, 1);
		let infoMaterial = new THREE.MeshBasicMaterial({ map: texture });
		let infoNode = new THREE.Mesh(plane, infoMaterial);

		return infoNode;
	}

	_createHintMesh(text) {
		const W = 200, H = 26;
		const canvas = document.createElement('canvas');
		canvas.width = W; canvas.height = H;
		const ctx = canvas.getContext('2d');
		let _prev = null;
		const texture = new THREE.CanvasTexture(canvas);
		const redraw = (t) => {
			if (t === _prev) return;
			_prev = t;
			ctx.clearRect(0, 0, W, H);
			const r = 5;
			ctx.fillStyle = 'rgba(8,10,22,0.82)';
			ctx.beginPath();
			ctx.moveTo(r, 0);
			ctx.lineTo(W - r, 0); ctx.quadraticCurveTo(W, 0, W, r);
			ctx.lineTo(W, H - r); ctx.quadraticCurveTo(W, H, W - r, H);
			ctx.lineTo(r, H);     ctx.quadraticCurveTo(0, H, 0, H - r);
			ctx.lineTo(0, r);     ctx.quadraticCurveTo(0, 0, r, 0);
			ctx.closePath(); ctx.fill();
			ctx.fillStyle = 'rgba(255,255,255,0.95)';
			ctx.font = 'bold 14px sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(t, W / 2, H / 2);
			texture.needsUpdate = true;
		};
		redraw(text);
		const geo = new THREE.PlaneGeometry(W / 2000, H / 2000);
		const mat = new THREE.MeshBasicMaterial({
			map: texture, transparent: true, side: THREE.DoubleSide, depthTest: false
		});
		const mesh = new THREE.Mesh(geo, mat);
		mesh.setText = redraw;
		mesh.getText = () => _prev;
		return mesh;
	}

	initControllerHints() {
		if (this._hints) return;
		this._hints = { primary: {}, secondary: {} };
		this._hintGroups = {};

		// Slots: face buttons → thumbstick → trigger → grip
		const slots = ['extra', 'thumbstick', 'trigger', 'grip'];

		[[this.cPrimary, 'primary'], [this.cSecondary, 'secondary']].forEach(([ctrl, side]) => {
			const xSign = ctrl.inputSource
				? (ctrl.inputSource.handedness === 'right' ? 1 : -1)
				: (side === 'primary' ? 1 : -1);

			// Attach to target-ray controller (confirmed correct plane in previous tests)
			const group = new THREE.Object3D();
			ctrl.add(group);
			this._hintGroups[side] = group;

			// Position the card beside the controller.
			// Orientation is overridden each frame (billboard) so individual mesh rotation stays 0.
			group.position.set(xSign * 0.07, 0.03, -0.04);

			slots.forEach((slot, i) => {
				const mesh = this._createHintMesh('');
				// Stack labels top → bottom; no rotation (billboard handles facing)
				mesh.position.set(0, (1.5 - i) * 0.022, 0);
				group.add(mesh);
				this._hints[side][slot] = mesh;
			});
		});

		this._hintState = null;
		this.updateHints();
	}

	updateHints() {
		if (!this._hints) return;

		const measuring = this.vrMeasureActive;
		const rightCtrl = this._getControllerByHand('right');
		const rightIsPrimary = (rightCtrl === this.cPrimary);
		// Unique state key including the primary role to invalidate after swap
		const state = (measuring ? 'MEASURE_' + this.navigationState : this.navigationState)
			+ (rightIsPrimary ? '_R' : '_L');
		if (state === this._hintState) return;
		this._hintState = state;

		const hp = this._hints.primary, hs = this._hints.secondary;
		const roleSlots = ['thumbstick', 'trigger', 'grip'];

		if (measuring) {
			// Primary retains its navigation role; secondary places the markers
			const navTrigger = { TELEPORT: 'Trigger: Teleport', MANIPULATE: 'Trigger: Grab' }[this.navigationState] || 'Trigger: —';
			const pSlots = ['⊙:Settings  ↔:Mode', navTrigger, 'Grip: —'];
			const sSlots = ['⊙:Appear  Stick:—', 'Trigger: Place', 'Grip: Cancel'];
			roleSlots.forEach((k, i) => { hp[k].setText(pSlots[i]); hs[k].setText(sSlots[i]); });
		} else {
			const defs = {
				EXPLORE: { p: ['⊙:Settings  ↕:Fly', 'Trigger: —', 'Grip: —'], s: ['⊙:Appear ↕↔:Orbit', 'Trigger: —', 'Grip: —'] },
				TELEPORT: { p: ['⊙:Settings  ↔:Mode', 'Trigger: Teleport', 'Grip: —'], s: ['⊙:Appear  ↕:Fly', 'Trigger: —', 'Grip: —'] },
				MANIPULATE: { p: ['⊙:Settings  ↔:Mode', 'Trigger: Grab', 'Grip: —'], s: ['⊙:Appear  Stick:—', 'Trigger: Scale/Rot', 'Grip: —'] },
				ORBITAL: { p: ['⊙:Settings  ↕:Zoom', 'Trigger: —', 'Grip: —'], s: ['⊙:Appear ↕↔:Orbit', 'Trigger: —', 'Grip: —'] },
			};
			const d = defs[this.navigationState] || defs.EXPLORE;
			roleSlots.forEach((k, i) => { hp[k].setText(d.p[i]); hs[k].setText(d.s[i]); });
		}
		const leftCtrl = this._getControllerByHand('left');
		const hRight = rightCtrl ? ((rightIsPrimary) ? hp : hs) : hp;
		const hLeft = leftCtrl ? ((leftCtrl === this.cPrimary) ? hp : hs) : hs;

		if (measuring) {
			if (rightIsPrimary) {
				hRight.extra.setText('A:Undo  B:Mode');
				hLeft.extra.setText('X:—  Y:Stop');
			} else {
				hRight.extra.setText('A:Undo  B:Stop');
				hLeft.extra.setText('X:—  Y:Mode');
			}
		} else {
			if (rightIsPrimary) {
				hRight.extra.setText('A:Rot-45  B:Mode');
				hLeft.extra.setText('X:Rot+45  Y:Mesure');
			} else {
				hRight.extra.setText('A:Rot-45  B:Mesure');
				hLeft.extra.setText('X:Rot+45  Y:Mode');
			}
		}
	}

	initMenu(controller) {
		if (this.menu) return;

		const node = new THREE.Object3D();
		node.visible = false;

		// Panel background
		const bgGeo = new THREE.PlaneGeometry(0.38, 0.80);
		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x111111, transparent: true, opacity: 0.85, side: THREE.DoubleSide
		});
		node.add(new THREE.Mesh(bgGeo, bgMat));

		// Title
		const title = this.createTextMesh(t('menu_settings'), 300, 40, 26);
		title.position.set(0, 0.215, 0.001);
		node.add(title);
		this._langLabels.push({ mesh: title, key: 'menu_settings' });

		// ── Modes of Transportation Section ──
		const modeDefs = [
			{ langKey: "mode_explore", state: "EXPLORE" },
			{ langKey: "mode_teleport", state: "TELEPORT" },
			{ langKey: "mode_manipulate", state: "MANIPULATE" },
			{ langKey: "mode_orbit", state: "ORBITAL" },
		];

		this.menuModeMeshes = [];
		var self = this;

		modeDefs.forEach(function (def, i) {
			var x = -0.15 + i * 0.10;
			var y = 0.13;

			var btnGeo = new THREE.PlaneGeometry(0.10, 0.04);
			var btnMat = new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide });
			var btn = new THREE.Mesh(btnGeo, btnMat);
			btn.position.set(x, y, 0.001);
			node.add(btn);

			var label = self.createTextMesh(t(def.langKey), 128, 36, 20);
			label.position.set(x, y, 0.002);
			node.add(label);

			self._langLabels.push({ mesh: label, key: def.langKey });
			self.menuModeMeshes.push({ btn: btn, modeName: def.mode });
			btn._state = def.state;
		});

		// SSeparator
		const sepGeo = new THREE.PlaneGeometry(0.34, 0.002);
		const sepMat = new THREE.MeshBasicMaterial({ color: 0x444444, side: THREE.DoubleSide });
		const sep = new THREE.Mesh(sepGeo, sepMat);
		sep.position.set(0, 0.09, 0.001);
		node.add(sep);

		// ── Section sliders ──
		const sliderDefs = [
			{ label: "Offset(m)", min: 0.5, max: 10.0, value: 1.8, key: "teleportOffset" },
			{ label: "PointSize", min: 0.1, max: 8.0, value: 1.0, key: "pointSize" },
			{ label: "PointBudget", min: 100000, max: 10000000, value: 1000000, key: "pointBudget" },
		];

		this.menuSliders = [];

		sliderDefs.forEach(function (def, i) {
			var y = 0.04 - i * 0.08;

			var label = self.createTextMesh(def.label + ": " + def.value, 256, 40, 22);
			label.position.set(-0.02, y + 0.022, 0.001);
			node.add(label);

			var trackGeo = new THREE.PlaneGeometry(0.22, 0.007);
			var trackMat = new THREE.MeshBasicMaterial({ color: 0x444444, side: THREE.DoubleSide });
			var track = new THREE.Mesh(trackGeo, trackMat);
			track.position.set(0.04, y, 0.001);
			node.add(track);

			var handleGeo = new THREE.SphereGeometry(0.008, 8, 8);
			var handleMat = new THREE.MeshBasicMaterial({ color: 0x00aaff });
			var handle = new THREE.Mesh(handleGeo, handleMat);
			var t = (def.value - def.min) / (def.max - def.min);
			handle.position.set(0.04 - 0.11 + t * 0.22, y, 0.002);
			node.add(handle);

			self.menuSliders.push({
				label: label, handle: handle,
				min: def.min, max: def.max,
				value: def.value, key: def.key,
				trackX: 0.04, trackWidth: 0.22, trackY: y,
				labelText: def.label,
			});
		});

		// ── Separator actions ──
		node.add(new THREE.Mesh(
			new THREE.PlaneGeometry(0.34, 0.002),
			new THREE.MeshBasicMaterial({ color: 0x444444, side: THREE.DoubleSide })
		)).position.set(0, -0.155, 0.001);

		// ── Toggle Hints ──
		const hintsBtnGeo = new THREE.PlaneGeometry(0.26, 0.034);
		const hintsBtnMat = new THREE.MeshBasicMaterial({ color: 0x3a3a20, side: THREE.DoubleSide });
		const hintsBtn = new THREE.Mesh(hintsBtnGeo, hintsBtnMat);
		hintsBtn.position.set(0.04, -0.180, 0.001);
		node.add(hintsBtn);
		const hintsLbl = self.createTextMesh('Hints: ON', 256, 30, 20);
		hintsLbl.position.set(0.04, -0.180, 0.002);
		node.add(hintsLbl);
		this.menuHintsRow = { y: -0.180, btn: hintsBtn, lbl: hintsLbl };

		// ── Button Reset View ──
		const resetBtnGeo = new THREE.PlaneGeometry(0.26, 0.034);
		const resetBtnMat = new THREE.MeshBasicMaterial({ color: 0x1a4a2a, side: THREE.DoubleSide });
		const resetBtn = new THREE.Mesh(resetBtnGeo, resetBtnMat);
		resetBtn.position.set(0.04, -0.215, 0.001);
		node.add(resetBtn);
		const resetLbl = self.createTextMesh(t('btn_reset'), 256, 30, 20);
		resetLbl.position.set(0.04, -0.215, 0.002);
		node.add(resetLbl);
		this._langLabels.push({ mesh: resetLbl, key: 'btn_reset' });
		this.menuResetRow = { y: -0.215, btn: resetBtn };

		// ── Button Clear Measurements ──
		node.add(new THREE.Mesh(
			new THREE.PlaneGeometry(0.34, 0.002),
			new THREE.MeshBasicMaterial({ color: 0x444444, side: THREE.DoubleSide })
		)).position.set(0, -0.248, 0.001);
		const clearBtnGeo = new THREE.PlaneGeometry(0.26, 0.034);
		const clearBtnMat = new THREE.MeshBasicMaterial({ color: 0x5a2a10, side: THREE.DoubleSide });
		const clearBtn = new THREE.Mesh(clearBtnGeo, clearBtnMat);
		clearBtn.position.set(0.04, -0.275, 0.001);
		node.add(clearBtn);
		const clearLbl = self.createTextMesh(t('btn_clear'), 256, 30, 20);
		clearLbl.position.set(0.04, -0.275, 0.002);
		node.add(clearLbl);
		this._langLabels.push({ mesh: clearLbl, key: 'btn_clear' });
		this.menuClearRow = { y: -0.275, btn: clearBtn };

		// ── Button Swap Hands ──
		node.add(new THREE.Mesh(
			new THREE.PlaneGeometry(0.34, 0.002),
			new THREE.MeshBasicMaterial({ color: 0x444444, side: THREE.DoubleSide })
		)).position.set(0, -0.300, 0.001);
		const swapBtnGeo = new THREE.PlaneGeometry(0.26, 0.034);
		const swapBtnMat = new THREE.MeshBasicMaterial({ color: 0x1a3a6a, side: THREE.DoubleSide });
		const swapBtn = new THREE.Mesh(swapBtnGeo, swapBtnMat);
		swapBtn.position.set(0.04, -0.325, 0.001);
		node.add(swapBtn);
		const swapLbl = self.createTextMesh(t('btn_swap'), 256, 30, 20);
		swapLbl.position.set(0.04, -0.325, 0.002);
		node.add(swapLbl);
		this._langLabels.push({ mesh: swapLbl, key: 'btn_swap' });
		this.menuSwapRow = { y: -0.325, btn: swapBtn };

		// ── Button Real Size ──
		node.add(new THREE.Mesh(
			new THREE.PlaneGeometry(0.34, 0.002),
			new THREE.MeshBasicMaterial({ color: 0x444444, side: THREE.DoubleSide })
		)).position.set(0, -0.350, 0.001);
		const realSizeBtnGeo = new THREE.PlaneGeometry(0.26, 0.034);
		const realSizeBtnMat = new THREE.MeshBasicMaterial({ color: 0x3a1a5a, side: THREE.DoubleSide });
		const realSizeBtn = new THREE.Mesh(realSizeBtnGeo, realSizeBtnMat);
		realSizeBtn.position.set(0.04, -0.375, 0.001);
		node.add(realSizeBtn);
		const realSizeLbl = self.createTextMesh(t('btn_realsize'), 256, 30, 20);
		realSizeLbl.position.set(0.04, -0.375, 0.002);
		node.add(realSizeLbl);
		this._langLabels.push({ mesh: realSizeLbl, key: 'btn_realsize' });
		this.menuRealSizeRow = { y: -0.375, btn: realSizeBtn };

		// Slider selection indicator
		var selGeo = new THREE.PlaneGeometry(0.005, 0.06);
		var selMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
		this.menuSelector = new THREE.Mesh(selGeo, selMat);
		node.add(this.menuSelector);
		node.position.set(0, 0.05, -0.1);
		node.rotation.set(-Math.PI / 4, 0, 0);
		controller.add(node);

		this.menu = node;
		this.menuSelectedIndex = 0;
		this.menuOpen = false;
		this.menuNavPrev = false;
		this.menuModeNavPrev = false;
		this._hintsVisible = true;
		this.menuHintsPrev = false;
		this.menuResetPrev = false;
		this.menuClearPrev = false;
		this.menuSwapPrev = false;
		this.menuRealSizePrev = false;
		this.btnMenuPrev = false;
		this.btnAPrev = false;
		this.btnBPrev = false;

		this.updateMenuSelector();
		this.updateModeButtons();
		this.modeLabel = this.createTextMesh("Fly", 200, 40, 22);
		this.modeLabel.position.set(0, 0.12, 0);
		controller.add(this.modeLabel);
	}

	updateMenuSelector() {
		if (!this.menuSelector || !this.menuSliders) return;
		const totalRows = 1 + this.menuSliders.length + 5; // +hints +reset +clear +swap +realSize
		const hintsIdx = totalRows - 5;
		const resetIdx = totalRows - 4;
		const clearIdx = totalRows - 3;
		const swapIdx = totalRows - 2;
		const realSizeIdx = totalRows - 1;
		const sel = this.menuSelectedIndex;

		if (sel === 0) {
			this.menuSelector.position.set(-0.155, 0.13, 0.002);
		} else if (sel < hintsIdx) {
			const s = this.menuSliders[sel - 1];
			this.menuSelector.position.set(-0.155, s.trackY, 0.002);
		} else if (sel === hintsIdx) {
			this.menuSelector.position.set(-0.155, this.menuHintsRow.y, 0.002);
		} else if (sel === resetIdx) {
			this.menuSelector.position.set(-0.155, this.menuResetRow.y, 0.002);
		} else if (sel === clearIdx) {
			this.menuSelector.position.set(-0.155, this.menuClearRow.y, 0.002);
		} else if (sel === swapIdx) {
			this.menuSelector.position.set(-0.155, this.menuSwapRow.y, 0.002);
		} else {
			this.menuSelector.position.set(-0.155, this.menuRealSizeRow.y, 0.002);
		}

		if (this.menuHintsRow) {
			const on = this._hintsVisible !== false;
			if (sel === hintsIdx) {
				this.menuHintsRow.btn.material.color.set(0xbbbb00);
			} else if (on) {
				this.menuHintsRow.btn.material.color.set(0x1a5a1a);
			} else {
				this.menuHintsRow.btn.material.color.set(0x5a1a1a);
			}
		}
		if (this.menuResetRow) {
			this.menuResetRow.btn.material.color.set(sel === resetIdx ? 0x00aa44 : 0x1a4a2a);
		}
		if (this.menuClearRow) {
			this.menuClearRow.btn.material.color.set(sel === clearIdx ? 0xff6600 : 0x5a2a10);
		}
		if (this.menuSwapRow) {
			this.menuSwapRow.btn.material.color.set(sel === swapIdx ? 0x0055ff : 0x1a3a6a);
		}
		if (this.menuRealSizeRow) {
			this.menuRealSizeRow.btn.material.color.set(sel === realSizeIdx ? 0xcc44ff : 0x3a1a5a);
		}
	}

	updateModeButtons() {
		if (!this.menuModeMeshes) return;
		var self = this;
		this.menuModeMeshes.forEach(function (item) {
			var isActive = self.mode === self[item.modeName];
			item.btn.material.color.set(isActive ? 0x0055ff : 0x333333);
		});
	}

	updateMenuSlider(index, deltaX) {
		if (!this.menuSliders) return;
		const s = this.menuSliders[index];
		const step = (s.max - s.min) * 0.01 * deltaX;
		s.value = Math.min(s.max, Math.max(s.min, s.value + step));

		const t = (s.value - s.min) / (s.max - s.min);
		s.handle.position.x = s.trackX - s.trackWidth / 2 + t * s.trackWidth;
		const disp = s.key === 'pointBudget'
			? (s.value >= 1e6 ? (s.value / 1e6).toFixed(1) + 'M' : Math.round(s.value / 1000) + 'k')
			: (Math.round(s.value * 10) / 10);
		s.label.setText(s.labelText + ": " + disp);

		if (s.key === 'pointSize') {
			this.viewer.scene.pointclouds.forEach(pc => { pc.material.size = s.value; });
		} else if (s.key === 'pointBudget') {
			this.viewer.setPointBudget(Math.round(s.value));
		} else if (this.mode_teleport) {
			this.mode_teleport[s.key] = s.value;
		}
	}

	initMenu2(controller) {
		if (this.menu2) return;
		const node = new THREE.Object3D();
		node.visible = false;
		const self = this;

		// Panels
		const bgGeo = new THREE.PlaneGeometry(0.38, 0.42);
		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x111122, transparent: true, opacity: 0.85, side: THREE.DoubleSide
		});
		node.add(new THREE.Mesh(bgGeo, bgMat));

		const title = this.createTextMesh(t('menu_tools'), 300, 40, 26);
		title.position.set(0, 0.248, 0.001);
		node.add(title);
		this._langLabels.push({ mesh: title, key: 'menu_tools' });

		// ── Toggles ──
		const toggleDefs = [
			{
				key: 'bg',
				optionLabels: ['BG: Skybox', 'BG: Gradient', 'BG: Black', 'BG: White', 'BG: None'],
				getIndex: () => {
					const v = self.viewer.getBackground ? self.viewer.getBackground() : 'skybox';
					const vals = ['skybox', 'gradient', 'black', 'white', null];
					const idx = vals.indexOf(v);
					return idx === -1 ? 0 : idx;
				},
				apply: (i) => {
					self.viewer.setBackground(['skybox', 'gradient', 'black', 'white', null][i]);
				},
			},
			{
				key: 'clip',
				optionLabels: ['Clip: None', 'Clip: Highlight', 'Clip: Inside', 'Clip: Outside'],
				getIndex: () => 0,
				apply: (i) => {
					const ct = Potree.ClipTask;
					if (!ct) return;
					self.viewer.setClipTask([ct.NONE, ct.HIGHLIGHT, ct.SHOW_INSIDE, ct.SHOW_OUTSIDE][i]);
				},
			},
			{
				key: 'measure',
				optionLabels: ['Tool: —', 'Tool: Point', 'Tool: Distance', 'Tool: Height'],
				getIndex: () => {
					if (!self.vrMeasureActive || !self.vrMeasure) return 0;
					const n = self.vrMeasure.name;
					if (n === 'Point') return 1;
					if (n === 'Distance') return 2;
					if (n === 'Height') return 3;
					return 0;
				},
				apply: (i) => {
					if (i === 0) { self.stopVRMeasurement(); return; }
					const cfgs = [null,
						{ showDistances: false, showCoordinates: true, maxMarkers: 1, closed: true, name: 'Point' },
						{ showDistances: true, maxMarkers: Infinity, name: 'Distance' },
						{ showDistances: false, showHeight: true, maxMarkers: 2, name: 'Height' },
					];
					self.startVRMeasurement(cfgs[i]);
				},
			},
			{
				key: 'lang',
				optionLabels: [t('btn_lang'), getLanguage() === 'fr' ? 'Language: EN' : 'Langue: FR'],
				getIndex: () => getLanguage() === 'fr' ? 0 : 1,
				apply: (i) => { setLanguage(['fr', 'en'][i]); },
			},
		];

		this.menu2Toggles = [];
		toggleDefs.forEach((def, i) => {
			const y = 0.195 - i * 0.040;
			const btnGeo = new THREE.PlaneGeometry(0.26, 0.036);
			const btnMat = new THREE.MeshBasicMaterial({ color: 0x223355, side: THREE.DoubleSide });
			const btn = new THREE.Mesh(btnGeo, btnMat);
			btn.position.set(0.04, y, 0.001);
			node.add(btn);
			const lbl = self.createTextMesh(def.optionLabels[0], 260, 32, 18);
			lbl.position.set(0.04, y, 0.002);
			node.add(lbl);
			self.menu2Toggles.push({ ...def, currentIndex: 0, btn, lbl, y });
		});

		this.menu2Sliders = [];

		const selGeo = new THREE.PlaneGeometry(0.005, 0.06);
		const selMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
		this.menu2Selector = new THREE.Mesh(selGeo, selMat);
		node.add(this.menu2Selector);

		node.position.set(0, 0.05, -0.1);
		node.rotation.set(-Math.PI / 4, 0, 0);
		controller.add(node);

		this.menu2 = node;
		this.menu2SelectedIndex = 0;
		this.menu2Open = false;
		this.menu2NavPrev = false;
		this.menu2ModeNavPrev = false;
		this.btnMenu2Prev = false;
		this.btnXPrev = false;
		this.btnYPrev = false;

		this.updateMenu2Selector();
	}

	updateMenu2Selector() {
		if (!this.menu2Selector) return;
		const numToggles = this.menu2Toggles ? this.menu2Toggles.length : 0;
		if (this.menu2SelectedIndex < numToggles) {
			const t = this.menu2Toggles[this.menu2SelectedIndex];
			this.menu2Selector.position.set(-0.155, t.y, 0.002);
		} else if (this.menu2Sliders) {
			const s = this.menu2Sliders[this.menu2SelectedIndex - numToggles];
			if (s) this.menu2Selector.position.set(-0.155, s.trackY, 0.002);
		}
	}

	updateMenu2Slider(index, deltaX) {
		if (!this.menu2Sliders) return;
		const s = this.menu2Sliders[index];
		if (!s) return;
		const step = (s.max - s.min) * 0.01 * deltaX;
		s.value = Math.min(s.max, Math.max(s.min, s.value + step));
		const t = (s.value - s.min) / (s.max - s.min);
		s.handle.position.x = s.trackX - s.trackWidth / 2 + t * s.trackWidth;
		const disp = s.key === 'pointBudget'
			? (s.value >= 1e6 ? (s.value / 1e6).toFixed(1) + 'M' : Math.round(s.value / 1000) + 'k')
			: (Math.round(s.value * 10) / 10);
		s.label.setText(s.labelText + ': ' + disp);
		switch (s.key) {
			case 'pointBudget': this.viewer.setPointBudget(Math.round(s.value)); break;
			case 'pointSize': this.viewer.scene.pointclouds.forEach(pc => { pc.material.size = s.value; }); break;
		}
	}

	syncMenu2Values() {
		if (!this.menu2Toggles || !this.menu2Sliders) return;
		// Sync toggles
		this.menu2Toggles.forEach(t => {
			if (t.key !== 'clip') {
				t.currentIndex = t.getIndex();
				t.lbl.setText(t.optionLabels[t.currentIndex]);
			}
		});
		// Sync sliders
		const viewer = this.viewer;
		const newVals = [
			viewer.getPointBudget ? viewer.getPointBudget() : 1000000,
			viewer.scene.pointclouds.length > 0 ? viewer.scene.pointclouds[0].material.size : 1.0,
		];
		this.menu2Sliders.forEach((s, i) => {
			s.value = Math.min(s.max, Math.max(s.min, newVals[i]));
			const t = (s.value - s.min) / (s.max - s.min);
			s.handle.position.x = s.trackX - s.trackWidth / 2 + t * s.trackWidth;
			const disp = s.key === 'pointBudget'
				? (s.value >= 1e6 ? (s.value / 1e6).toFixed(1) + 'M' : Math.round(s.value / 1000) + 'k')
				: (Math.round(s.value * 10) / 10);
			s.label.setText(s.labelText + ': ' + disp);
		});
	}

	_applyLang() {
		for (const entry of this._langLabels) {
			entry.mesh.setText(t(entry.key));
		}
		// Mettre à jour le toggle langue dans menu2
		if (this.menu2Toggles) {
			const langToggle = this.menu2Toggles.find(tg => tg.key === 'lang');
			if (langToggle) {
				langToggle.optionLabels = [t('btn_lang'), getLanguage() === 'fr' ? 'Language: EN' : 'Langue: FR'];
				langToggle.lbl.setText(langToggle.optionLabels[langToggle.currentIndex]);
			}
		}
	}

	startVRMeasurement(params) {
		this.stopVRMeasurement();

		const measure = new Measure();
		// In VR, the scene doesn't necessarily have ambient light → BasicMaterial is visible without light
		measure.createSphereMaterial = () => new THREE.MeshBasicMaterial({
			color: measure.color,
			depthTest: false,
			depthWrite: false,
		});
		measure.showDistances = params.showDistances ?? true;
		measure.showCoordinates = params.showCoordinates ?? false;
		measure.showHeight = params.showHeight ?? false;
		measure.showArea = params.showArea ?? false;
		measure.showAngles = params.showAngles ?? false;
		measure.showEdges = params.showEdges ?? true;
		measure.closed = params.closed ?? false;
		measure.maxMarkers = (params.maxMarkers != null) ? params.maxMarkers : Infinity;
		measure.name = params.name || 'Measurement';

		// scene.addMeasurement adds to scene.measurements and dispatches measurement_added
		// This records the measurement in the MeasuringTool rendering pipeline
		this.viewer.scene.addMeasurement(measure);

		// First marker = preview, placed under the secondary controller
		const origin = this.cSecondary ? this.toScene(this.cSecondary.position) : new THREE.Vector3();
		measure.addMarker(origin);
		if (!this._measureLaser) {
			this._measureLaser = Potree.Utils.debugLine(
				this.viewer.sceneVR,
				new THREE.Vector3(), new THREE.Vector3(), 0xffff00
			);
			this._measureLaser.node.material.depthTest = false;
			this._measureLaser.node.material.transparent = true;
		}
		this._measureLaser.node.visible = false;

		this.vrMeasure = measure;
		this.vrMeasureActive = true;
		this.vrMeasureMaxMarkers = (params.maxMarkers != null) ? params.maxMarkers : Infinity;
		this.vrMeasurePlaced = 0;
		this._hintState = null;
	}

	stopVRMeasurement() {
		if (!this.vrMeasureActive) return;
		if (this.vrMeasure && this.vrMeasure.points.length > this.vrMeasurePlaced) {
			this.vrMeasure.removeMarker(this.vrMeasure.points.length - 1);
		}
		if (this.vrMeasure && this.vrMeasurePlaced === 0) {
			this.viewer.scene.removeMeasurement(this.vrMeasure);
		}
		if (this._measureLaser) this._measureLaser.node.visible = false;
		this.vrMeasureActive = false;
		this.vrMeasure = null;
		this._hintState = null;
	}

	_vrMeasurePlace() {
		const ctrl = this.cSecondary;
		const origin = this.toScene(ctrl.position);
		const fwd = new THREE.Vector3(0, 0, -1)
			.applyQuaternion(ctrl.quaternion)
			.applyQuaternion(this.node.quaternion)
			.normalize();
		const hit = Utils.getVRPointCloudIntersectionCPU(
			new THREE.Ray(origin, fwd), this.viewer.scene.pointclouds, { projectOnRay: false, wideRadius: false }
		);
		if (!hit) return;

		const m = this.vrMeasure;
		m.setPosition(m.points.length - 1, hit.position.clone());
		this.vrMeasurePlaced++;

		if (this.vrMeasurePlaced >= this.vrMeasureMaxMarkers) {
			this.vrMeasureActive = false;
			this.vrMeasure = null;
			this._hintState = null;
		} else {
			m.addMarker(hit.position.clone());
		}
	}

	toScene(vec) {
		this.node.updateMatrixWorld(true);
		return vec.clone().applyMatrix4(this.node.matrixWorld);

	}

	toVR(vecWorld) {
		this.node.updateMatrixWorld(true);
		const matInv = this.node.matrixWorld.clone().invert();
		return vecWorld.clone().applyMatrix4(matInv);
	}

	setMode(mode) {

		if (this.mode === mode) {
			return;
		}

		if (this.mode) {
			this.mode.end(this);
		}

		for (let controller of [this.cPrimary, this.cSecondary]) {

			let start = {
				position: controller.position.clone(),
				rotation: controller.rotation.clone(),
			};

			controller.start = start;
		}

		this.mode = mode;
		this.mode.start(this);
	}

	onSqueezeStart(controller) {
		// Grip is sensitive to natural hand tension — only cancel active measurement, nothing else
		if (this.vrMeasureActive) {
			this.stopVRMeasurement();
		}
	}

	onTriggerStart(controller) {
		if (this.vrMeasureActive && this.vrMeasure && controller === this.cSecondary) {
			this._vrMeasurePlace();
			return;
		}
		this.triggered.add(controller);

		if (this.navigationState === 'TELEPORT' && controller === this.cPrimary) {
			this.mode_teleport.executeTeleport(this);
			return;
		}

		if (this.navigationState === 'MANIPULATE') {
			this.updateCurrentMode();
			return;
		}
		// EXPLORE and ORBITAL : trigger ignored
	}

	onTriggerEnd(controller) {
		this.triggered.delete(controller);

		if (this.navigationState === 'MANIPULATE') {
			this.updateCurrentMode();
			return;
		}
		// TELEPORT : no need to update mode, just wait for next trigger
	}

	updateCurrentMode() {
		if (this.navigationState === 'EXPLORE') {
			this.setMode(this.mode_fly);
		} else if (this.navigationState === 'TELEPORT') {
			this.setMode(this.mode_teleport);
		} else if (this.navigationState === 'MANIPULATE') {
			if (this.triggered.size === 0) this.setMode(this.mode_fly);
			else if (this.triggered.size === 1) this.setMode(this.mode_translate);
			else if (this.triggered.size === 2) this.setMode(this.mode_rotScale);
		} else if (this.navigationState === 'ORBITAL') {
			this.setMode(this.mode_orbit);
		}
	}

	updateModeButtons() {
		if (!this.menuModeMeshes) return;
		var self = this;
		this.menuModeMeshes.forEach(function (item) {
			var isActive = item.btn._state === self.navigationState;
			item.btn.material.color.set(isActive ? 0x0055ff : 0x333333);
		});
	}

	onStart() {

		let position = this.viewer.scene.view.position.clone();
		let direction = this.viewer.scene.view.direction;
		direction.multiplyScalar(-1);

		let target = position.clone().add(direction);
		target.z = position.z;

		let scale = this.viewer.getMoveSpeed();

		this.node.position.copy(position);
		this.node.lookAt(target);
		this.node.scale.set(scale, scale, scale);
		this.node.updateMatrix();
		this.node.updateMatrixWorld();
	}

	onEnd() {
		if (this.modeLabel) this.modeLabel.visible = false;
	}

	swapControllers() {
		const oldPrimary = this.cPrimary;
		const oldSecondary = this.cSecondary;

		// Exchange references
		this.cPrimary = oldSecondary;
		this.cSecondary = oldPrimary;

		if (this.menu) {
			oldPrimary.remove(this.menu);
			this.cPrimary.add(this.menu);
		}
		if (this.menu2) {
			oldSecondary.remove(this.menu2);
			this.cSecondary.add(this.menu2);
		}
		if (this.modeLabel) {
			oldPrimary.remove(this.modeLabel);
			this.cPrimary.add(this.modeLabel);
		}
		if (this._hintGroups) {
			if (this._hintGroups.primary) oldPrimary.remove(this._hintGroups.primary);
			if (this._hintGroups.secondary) oldSecondary.remove(this._hintGroups.secondary);
		}
		this._hints = null;
		this._hintGroups = null;
		this._hintState = null;
		this.initControllerHints();

		this.menuOpen = false;
		this.menu2Open = false;
		if (this.menu) this.menu.visible = false;
		if (this.menu2) this.menu2.visible = false;

		const cur = this.mode;
		this.mode = null;
		this.setMode(cur);

		// Reset buttons states
		this.btnMenuPrev = false;
		this.btnMenu2Prev = false;
		this.btnAPrev = false;
		this.btnBPrev = false;
		this.btnXPrev = false;
		this.btnYPrev = false;
		this.menuHintsPrev = false;
		this.menuResetPrev = false;
		this.menuClearPrev = false;
		this.menuSwapPrev = false;
		this.menuRealSizePrev = false;
	}

	_applyRealWorldScale() {
		const cam = this.viewer.renderer.xr.getCamera(fakeCam);
		const camVRPos = cam.getWorldPosition(new THREE.Vector3());
		const camVRDir = cam.getWorldDirection(new THREE.Vector3());
		const camScenePos = this.toScene(camVRPos);
		const currentScale = this.node.scale.x;
		if (Math.abs(currentScale - 1.0) < 1e-6) return;

		const k = 1.0 / currentScale;
		this.node.applyMatrix4(new THREE.Matrix4().makeTranslation(-camScenePos.x, -camScenePos.y, -camScenePos.z));
		this.node.applyMatrix4(new THREE.Matrix4().makeScale(k, k, k));
		this.node.applyMatrix4(new THREE.Matrix4().makeTranslation(camScenePos.x, camScenePos.y, camScenePos.z));
		this.node.matrix.decompose(this.node.position, this.node.quaternion, this.node.scale);
		this.node.updateMatrixWorld();

		// Sync LOD
		const sceneDir = camVRDir.clone().applyQuaternion(this.node.quaternion).normalize();
		this.viewer.scene.view.setView(camScenePos, camScenePos.clone().add(sceneDir));
		this.viewer.setMoveSpeed(1.0);
	}

	_getControllerByHand(hand) {
		// Priority: cache established on connection (more reliable than the current inputSource)
		if (hand === 'left' && this._leftCtrl) return this._leftCtrl;
		if (hand === 'right' && this._rightCtrl) return this._rightCtrl;
		// Fallback : scan the current inputSources
		for (const ctrl of [this.cPrimary, this.cSecondary]) {
			if (ctrl && ctrl.inputSource && ctrl.inputSource.handedness === hand) return ctrl;
		}
		// Fallback
		if (hand === 'left') return this.cPrimary;
		if (hand === 'right') return this.cSecondary;
		return null;
	}

	// 45° rotation of the world around the VR camera position (vertical Z axis)
	_snapRotate(dir = 1) {
		if (!this.viewer.renderer.xr.isPresenting) return;
		const angle = (Math.PI / 4) * dir;
		const qZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);

		const camVR = this.viewer.renderer.xr.getCamera(fakeCam);
		const camVRPos = camVR.getWorldPosition(new THREE.Vector3());
		const camScenePos = this.toScene(camVRPos);

		const newQuat = qZ.clone().multiply(this.node.quaternion);
		const scale = this.node.scale.x;
		const rotatedCam = camVRPos.clone().applyQuaternion(newQuat).multiplyScalar(scale);
		this.node.position.copy(camScenePos.clone().sub(rotatedCam));
		this.node.quaternion.copy(newQuat);
		this.node.updateMatrixWorld();
		// Do NOT call viewer.scene.view.setView here — VR camera uses this.node directly,
		// and touching setView corrupts OrbitMode's stored target.
	}

	// reset the view
	_resetView() {
		const pcs = this.viewer.scene.pointclouds;
		if (pcs.length === 0) return;
		const box = new THREE.Box3();
		for (const pc of pcs) box.union(pc.boundingBox.clone().applyMatrix4(pc.matrixWorld));
		if (box.isEmpty()) return;

		const center = box.getCenter(new THREE.Vector3());
		const size = box.getSize(new THREE.Vector3()).length();
		const dir = new THREE.Vector3(0.5, -1, 0.7).normalize();
		const eyePos = center.clone().add(dir.clone().multiplyScalar(size * 0.6));

		this.viewer.scene.view.setView(eyePos, center);

		if (this.viewer.renderer.xr.isPresenting) {
			const camVR = this.viewer.renderer.xr.getCamera(fakeCam);
			const camVRPos = camVR.getWorldPosition(new THREE.Vector3());
			const scale = this.node.scale.x;
			const rotated = camVRPos.clone().applyQuaternion(this.node.quaternion).multiplyScalar(scale);
			this.node.position.copy(eyePos.clone().sub(rotated));
			this.node.updateMatrixWorld();

			if (this.mode_orbit) {
				this.mode_orbit.center.copy(center);
				const camScenePos = this.toScene(camVRPos);
				this.mode_orbit.orbitRadius = camScenePos.distanceTo(center);
				this.mode_orbit._totalYaw = 0;
				this.mode_orbit._totalPitch = 0;
			}
		}
	}

	setScene(scene) {
		this.scene = scene;
	}

	getCamera() {
		let reference = this.viewer.scene.getActiveCamera();
		let camera = new THREE.PerspectiveCamera();

		// let scale = this.node.scale.x;
		let scale = this.viewer.getMoveSpeed();
		//camera.near = 0.01 / scale;
		camera.near = 0.1;
		camera.far = 1000;
		// camera.near = reference.near / scale;
		// camera.far = reference.far / scale;
		camera.up.set(0, 0, 1);
		camera.lookAt(new THREE.Vector3(0, -1, 0));
		camera.updateMatrix();
		camera.updateMatrixWorld();

		camera.position.copy(this.node.position);
		camera.rotation.copy(this.node.rotation);
		camera.scale.set(scale, scale, scale);
		camera.updateMatrix();
		camera.updateMatrixWorld();
		camera.matrixAutoUpdate = false;
		camera.parent = camera;

		return camera;
	}

	update(delta) {
		const isVR = this.viewer.renderer.xr.isPresenting;
		if (!isVR) {
			if (this.modeLabel) this.modeLabel.visible = false;
			if (this._hintGroups) {
				if (this._hintGroups.primary) this._hintGroups.primary.visible = false;
				if (this._hintGroups.secondary) this._hintGroups.secondary.visible = false;
			}
			this.mode.update(this, delta);
			return;
		}

		// Fade-to-black teleport
		if (this._fadeState) {
			const FADE_DUR = 0.12;
			if (!this._fadeMesh) {
				const geo = new THREE.SphereBufferGeometry(0.3, 16, 8);
				const mat = new THREE.MeshBasicMaterial({
					color: 0x000000, transparent: true, opacity: 0,
					depthTest: false, depthWrite: false, side: THREE.BackSide,
				});
				this._fadeMesh = new THREE.Mesh(geo, mat);
				this._fadeMesh.renderOrder = 9999;
				this.viewer.sceneVR.add(this._fadeMesh);
			}
			const camVR = this.viewer.renderer.xr.getCamera(fakeCam);
			this._fadeMesh.position.copy(camVR.getWorldPosition(new THREE.Vector3()));
			this._fadeMesh.visible = true;

			if (this._fadeState === 'out') {
				this._fadeT = Math.min(1, this._fadeT + delta / FADE_DUR);
				this._fadeMesh.material.opacity = this._fadeT;
				if (this._fadeT >= 1) {
					// Instant teleportation at the moment of total darkness
					this.node.position.copy(this._fadeDest);
					this.node.updateMatrixWorld();
					const vrPos = camVR.getWorldPosition(new THREE.Vector3());
					const vrDir = camVR.getWorldDirection(new THREE.Vector3());
					const scale = this.node.scale.x;
					const scenePos = toScene(vrPos, this.node);
					const sceneDir = toScene(vrPos.clone().add(vrDir), this.node).sub(scenePos).normalize();
					this.viewer.scene.view.setView(scenePos, scenePos.clone().add(sceneDir.multiplyScalar(scale)));
					this._fadeState = 'in';
				}
			} else if (this._fadeState === 'in') {
				this._fadeT = Math.max(0, this._fadeT - delta / FADE_DUR);
				this._fadeMesh.material.opacity = this._fadeT;
				if (this._fadeT <= 0) {
					this._fadeMesh.visible = false;
					this._fadeState = null;
					this._fadeDest = null;
				}
			}
		}

		// 1. Menu button (LEFT hand - cPrimary)
		if (this.cPrimary && this.cPrimary.inputSource && this.cPrimary.inputSource.gamepad) {
			const gpL = this.cPrimary.inputSource.gamepad;
			const btnMenu = gpL.buttons[3];
			if (btnMenu && btnMenu.pressed && !this.btnMenuPrev) {
				this.menuOpen = !this.menuOpen;
				if (this.menu) this.menu.visible = this.menuOpen;
			}
			this.btnMenuPrev = btnMenu ? btnMenu.pressed : false;
		}


		// 2. Joystick cPrimary → unified menu navigation
		// Vertical ↕: select the line (0 = modes, 1..n = sliders)
		// Horizontal ↔: change the value (cycle mode or adjust slider)
		if (this.menuOpen && this.cPrimary && this.cPrimary.inputSource && this.cPrimary.inputSource.gamepad) {
			const gp = this.cPrimary.inputSource.gamepad;
			const axisX = gp.axes[2] || 0;
			const axisY = gp.axes[3] || 0;
			const totalRows = 1 + (this.menuSliders ? this.menuSliders.length : 0) + 5; // +hints +reset +clear +swap +realSize
			const hintsRowIdx = totalRows - 5;
			const resetRowIdx = totalRows - 4;
			const clearRowIdx = totalRows - 3;
			const swapRowIdx = totalRows - 2;
			const realSizeRowIdx = totalRows - 1;

			// Vertical → navigate between lines (debounced)
			if (Math.abs(axisY) > 0.5 && !this.menuNavPrev) {
				this.menuSelectedIndex = (this.menuSelectedIndex + (axisY > 0 ? 1 : -1) + totalRows) % totalRows;
				this.updateMenuSelector();
			}
			this.menuNavPrev = Math.abs(axisY) > 0.5;

			// Horizontal → edit the selected line
			if (this.menuSelectedIndex === 0) {
				// Line 0: change mode (debounced)
				if (Math.abs(axisX) > 0.5 && !this.menuModeNavPrev) {
					const states = ['EXPLORE', 'TELEPORT', 'MANIPULATE', 'ORBITAL'];
					const cur = states.indexOf(this.navigationState);
					const next = (cur + (axisX > 0 ? 1 : -1) + states.length) % states.length;
					this.navigationState = states[next];
					this.updateCurrentMode();
					this.updateModeButtons();
				}
				this.menuModeNavPrev = Math.abs(axisX) > 0.5;
			} else if (this.menuSelectedIndex < hintsRowIdx) {
				// Sliders Lines : adjust (continuously)
				this.menuModeNavPrev = false;
				this.menuHintsPrev = false;
				this.menuResetPrev = false;
				this.menuClearPrev = false;
				this.menuSwapPrev = false;
				if (Math.abs(axisX) > 0.1) {
					this.updateMenuSlider(this.menuSelectedIndex - 1, axisX);
				}
			} else if (this.menuSelectedIndex === hintsRowIdx) {
				// Toggle Hints (debounced)
				this.menuModeNavPrev = false;
				this.menuResetPrev = false;
				this.menuClearPrev = false;
				this.menuSwapPrev = false;
				if (Math.abs(axisX) > 0.5 && !this.menuHintsPrev) {
					this._hintsVisible = this._hintsVisible === false;
					if (this.menuHintsRow) {
						this.menuHintsRow.lbl.setText(this._hintsVisible === false ? 'Hints: OFF' : 'Hints: ON');
					}
					this.updateMenuSelector();
				}
				this.menuHintsPrev = Math.abs(axisX) > 0.5;
			} else if (this.menuSelectedIndex === resetRowIdx) {
				// Reset View (debounced)
				this.menuModeNavPrev = false;
				this.menuHintsPrev = false;
				this.menuClearPrev = false;
				this.menuSwapPrev = false;
				if (Math.abs(axisX) > 0.5 && !this.menuResetPrev) {
					this._resetView();
				}
				this.menuResetPrev = Math.abs(axisX) > 0.5;
			} else if (this.menuSelectedIndex === clearRowIdx) {
				// Clear All Measurements (debounced)
				this.menuModeNavPrev = false;
				this.menuHintsPrev = false;
				this.menuResetPrev = false;
				this.menuSwapPrev = false;
				if (Math.abs(axisX) > 0.5 && !this.menuClearPrev) {
					if (this.vrMeasureActive) this.stopVRMeasurement();
					this.viewer.scene.removeAllMeasurements();
				}
				this.menuClearPrev = Math.abs(axisX) > 0.5;
			} else if (this.menuSelectedIndex === swapRowIdx) {
				// Swap Hands
				this.menuModeNavPrev = false;
				this.menuHintsPrev = false;
				this.menuResetPrev = false;
				this.menuClearPrev = false;
				this.menuRealSizePrev = false;
				if (Math.abs(axisX) > 0.5 && !this.menuSwapPrev) {
					this.swapControllers();
					this.menuOpen = false;
					if (this.menu) this.menu.visible = false;
				}
				this.menuSwapPrev = Math.abs(axisX) > 0.5;
			} else if (this.menuSelectedIndex === realSizeRowIdx) {
				// Real Size
				this.menuModeNavPrev = false;
				this.menuHintsPrev = false;
				this.menuResetPrev = false;
				this.menuClearPrev = false;
				this.menuSwapPrev = false;
				if (Math.abs(axisX) > 0.5 && !this.menuRealSizePrev) {
					this._applyRealWorldScale();
				}
				this.menuRealSizePrev = Math.abs(axisX) > 0.5;
			}
		}

		// 3. Button [3] cSecondary → toggle menu2 (Appearance)
		if (this.cSecondary && this.cSecondary.inputSource && this.cSecondary.inputSource.gamepad) {
			const gpR = this.cSecondary.inputSource.gamepad;
			const btnMenu2 = gpR.buttons[3];
			if (btnMenu2 && btnMenu2.pressed && !this.btnMenu2Prev) {
				this.menu2Open = !this.menu2Open;
				if (this.menu2) {
					this.menu2.visible = this.menu2Open;
					if (this.menu2Open) this.syncMenu2Values();
				}
			}
			this.btnMenu2Prev = btnMenu2 ? btnMenu2.pressed : false;
		}

		// 4. Joystick cSecondary → navigation menu2
		// Vertical ↕: select the row (toggles then sliders)
		// Horizontal ↔: cycle through the selected option or adjust the slider
		if (this.menu2Open && this.cSecondary && this.cSecondary.inputSource && this.cSecondary.inputSource.gamepad) {
			const gp = this.cSecondary.inputSource.gamepad;
			const axisX = gp.axes[2] || 0;
			const axisY = gp.axes[3] || 0;
			const numToggles = this.menu2Toggles ? this.menu2Toggles.length : 0;
			const numSliders = this.menu2Sliders ? this.menu2Sliders.length : 0;
			const totalRows = numToggles + numSliders;

			if (Math.abs(axisY) > 0.5 && !this.menu2NavPrev) {
				this.menu2SelectedIndex = (this.menu2SelectedIndex + (axisY > 0 ? 1 : -1) + totalRows) % totalRows;
				this.updateMenu2Selector();
			}
			this.menu2NavPrev = Math.abs(axisY) > 0.5;

			if (this.menu2SelectedIndex < numToggles) {
				if (Math.abs(axisX) > 0.5 && !this.menu2ModeNavPrev) {
					const tog = this.menu2Toggles[this.menu2SelectedIndex];
					tog.currentIndex = (tog.currentIndex + (axisX > 0 ? 1 : -1) + tog.optionLabels.length) % tog.optionLabels.length;
					tog.lbl.setText(tog.optionLabels[tog.currentIndex]);
					tog.apply(tog.currentIndex);
				}
				this.menu2ModeNavPrev = Math.abs(axisX) > 0.5;
			} else {
				this.menu2ModeNavPrev = false;
				if (Math.abs(axisX) > 0.1) {
					this.updateMenu2Slider(this.menu2SelectedIndex - numToggles, axisX);
				}
			}
		}


		// 5. A/B = always RIGHT joystick, X/Y = always LEFT joystick (physical, not role-based)
		const rightCtrl = this._getControllerByHand('right');
		const leftCtrl = this._getControllerByHand('left');

		if (rightCtrl && rightCtrl.inputSource && rightCtrl.inputSource.gamepad) {
			const gp = rightCtrl.inputSource.gamepad;

			// A: undo if measurement active, otherwise rotate snap 45°
			const btnA = gp.buttons[4];
			if (btnA && btnA.pressed && !this.btnAPrev) {
				if (this.vrMeasureActive && this.vrMeasure && this.vrMeasurePlaced > 0) {
					this.vrMeasure.removeMarker(this.vrMeasure.points.length - 1); // preview
					this.vrMeasure.removeMarker(this.vrMeasure.points.length - 1); // confirmé
					this.vrMeasurePlaced--;
					const actionCtrl = this.cSecondary || rightCtrl;
					this.vrMeasure.addMarker(this.toScene(actionCtrl.position));
				} else if (!this.vrMeasureActive) {
					this._snapRotate(-1);
				}
			}
			this.btnAPrev = btnA ? btnA.pressed : false;

			// B: measurement (if right = secondary) or cycler navigation mode (if right = primary)
			const btnB = gp.buttons[5];
			if (btnB && btnB.pressed && !this.btnBPrev && !this.menuOpen && !this.menu2Open) {
				if (rightCtrl === this.cSecondary) {
					if (this.vrMeasureActive) {
						this.stopVRMeasurement();
					} else {
						this.startVRMeasurement({ showDistances: true, maxMarkers: Infinity, name: 'Distance' });
					}
				} else {
					const states = ['EXPLORE', 'TELEPORT', 'MANIPULATE', 'ORBITAL'];
					const next = (states.indexOf(this.navigationState) + 1) % states.length;
					this.navigationState = states[next];
					this.updateCurrentMode();
					this.updateModeButtons();
				}
			}
			this.btnBPrev = btnB ? btnB.pressed : false;
		}

		if (leftCtrl && leftCtrl.inputSource && leftCtrl.inputSource.gamepad) {
			const gp = leftCtrl.inputSource.gamepad;

			// X (bottom left button): snap rotation -45° — symmetrical to A (bottom right)
			const btnX = gp.buttons[4];
			if (btnX && btnX.pressed && !this.btnXPrev && !this.menuOpen && !this.menu2Open) {
				this._snapRotate(1);
			}
			this.btnXPrev = btnX ? btnX.pressed : false;

			// Y: measurement (if left = secondary) or cycler navigation mode (if left = primary)

			const btnY = gp.buttons[5];
			if (btnY && btnY.pressed && !this.btnYPrev && !this.menuOpen && !this.menu2Open) {
				if (leftCtrl === this.cSecondary) {
					if (this.vrMeasureActive) {
						this.stopVRMeasurement();
					} else {
						this.startVRMeasurement({ showDistances: true, maxMarkers: Infinity, name: 'Distance' });
					}
				} else {
					const states = ['EXPLORE', 'TELEPORT', 'MANIPULATE', 'ORBITAL'];
					const next = (states.indexOf(this.navigationState) + 1) % states.length;
					this.navigationState = states[next];
					this.updateCurrentMode();
					this.updateModeButtons();
				}
			}
			this.btnYPrev = btnY ? btnY.pressed : false;
		}

		this.mode.update(this, delta);
		if (this.modeLabel) {
			this.modeLabel.setText(this.navigationState);
			this.updateModeButtons();
		}

		// Updated VR measurement preview marker (secondary controller)
		if (this.vrMeasureActive && this.vrMeasure && this.cSecondary) {
			const ctrl = this.cSecondary;
			const origin = this.toScene(ctrl.position);
			const fwd = new THREE.Vector3(0, 0, -1)
				.applyQuaternion(ctrl.quaternion)
				.applyQuaternion(this.node.quaternion)
				.normalize();

			const measureRay = new THREE.Ray(origin, fwd);
			const hit = Utils.getVRPointCloudIntersectionCPU(
				measureRay, this.viewer.scene.pointclouds, { projectOnRay: false, wideRadius: false }
			);
			this._measurePickedPos = hit ? hit.position.clone() : null;

			if (this._measurePickedPos && this.vrMeasure.points.length > 0) {
				if (!this._measureSmoothedPos) {
					this._measureSmoothedPos = this._measurePickedPos.clone();
				} else {
					const t = 1 - Math.exp(-12 * delta);
					this._measureSmoothedPos.lerp(this._measurePickedPos, t);
				}
				this.vrMeasure.setPosition(this.vrMeasure.points.length - 1, this._measureSmoothedPos);

				// Laser jaune : controller → hit (seulement quand il y a un hit)
				if (this._measureLaser) {
					const vrHit = this.toVR(this._measureSmoothedPos);
					this._measureLaser.set(ctrl.position, vrHit);
					this._measureLaser.node.visible = true;
					this._measureLaser.node.material.color.set(0xffff00);
				}
			} else {
				if (this._measureLaser) this._measureLaser.node.visible = false;
			}
		} else {
			this._measurePickedPos = null;
			this._measureSmoothedPos = null;
			if (this._measureLaser) this._measureLaser.node.visible = false;
		}

		this.updateHints();
		if (this._hintGroups) {
			const show = !this.menuOpen && !this.menu2Open && (this._hintsVisible !== false);
			this._hintGroups.primary.visible = show;
			this._hintGroups.secondary.visible = show;

			// Billboard: rotate each hint group to face the XR camera every frame
			// group.world_quat = parent_world * local → set local = parent_world^-1 * cam_world
			// so group.world_quat = cam_world → plane +Z faces toward user
			if (show) {
				const cam = this.viewer.renderer.xr.getCamera(fakeCam);
				const camQ = cam.getWorldQuaternion(new THREE.Quaternion());
				for (const side of ['primary', 'secondary']) {
					const group = this._hintGroups[side];
					if (!group || !group.parent) continue;
					const parentQ = group.parent.getWorldQuaternion(new THREE.Quaternion());
					group.quaternion.copy(parentQ.clone().invert().multiply(camQ));
				}
			}
		}
	}
};
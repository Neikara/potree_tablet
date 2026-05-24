
import * as THREE from "../../libs/three.js/build/three.module.js";
import {Measure} from "./Measure.js";
import {Utils} from "../utils.js";
import {CameraMode} from "../defines.js";
import { EventDispatcher } from "../EventDispatcher.js";
import { t } from "../i18n.js";

function updateAzimuth(viewer, measure){

	const azimuth = measure.azimuth;

	const isOkay = measure.points.length === 2;

	azimuth.node.visible = isOkay && measure.showAzimuth;

	if(!azimuth.node.visible){
		return;
	}

	const camera = viewer.scene.getActiveCamera();
	const renderAreaSize = viewer.renderer.getSize(new THREE.Vector2());
	const width = renderAreaSize.width;
	const height = renderAreaSize.height;
	
	const [p0, p1] = measure.points;
	const r = p0.position.distanceTo(p1.position);
	const northVec = Utils.getNorthVec(p0.position, r, viewer.getProjection());
	const northPos = p0.position.clone().add(northVec);

	azimuth.center.position.copy(p0.position);
	azimuth.center.scale.set(2, 2, 2);
	
	azimuth.center.visible = false;
	// azimuth.target.visible = false;


	{ // north
		azimuth.north.position.copy(northPos);
		azimuth.north.scale.set(2, 2, 2);

		let distance = azimuth.north.position.distanceTo(camera.position);
		let pr = Utils.projectedRadius(1, camera, distance, width, height);

		let scale = (5 / pr);
		azimuth.north.scale.set(scale, scale, scale);
	}

	{ // target
		azimuth.target.position.copy(p1.position);
		azimuth.target.position.z = azimuth.north.position.z;

		let distance = azimuth.target.position.distanceTo(camera.position);
		let pr = Utils.projectedRadius(1, camera, distance, width, height);

		let scale = (5 / pr);
		azimuth.target.scale.set(scale, scale, scale);
	}


	azimuth.circle.position.copy(p0.position);
	azimuth.circle.scale.set(r, r, r);
	azimuth.circle.material.resolution.set(width, height);

	// to target
	azimuth.centerToTarget.geometry.setPositions([
		0, 0, 0,
		...p1.position.clone().sub(p0.position).toArray(),
	]);
	azimuth.centerToTarget.position.copy(p0.position);
	azimuth.centerToTarget.geometry.verticesNeedUpdate = true;
	azimuth.centerToTarget.geometry.computeBoundingSphere();
	azimuth.centerToTarget.computeLineDistances();
	azimuth.centerToTarget.material.resolution.set(width, height);

	// to target ground
	azimuth.centerToTargetground.geometry.setPositions([
		0, 0, 0,
		p1.position.x - p0.position.x,
		p1.position.y - p0.position.y,
		0,
	]);
	azimuth.centerToTargetground.position.copy(p0.position);
	azimuth.centerToTargetground.geometry.verticesNeedUpdate = true;
	azimuth.centerToTargetground.geometry.computeBoundingSphere();
	azimuth.centerToTargetground.computeLineDistances();
	azimuth.centerToTargetground.material.resolution.set(width, height);

	// to north
	azimuth.centerToNorth.geometry.setPositions([
		0, 0, 0,
		northPos.x - p0.position.x,
		northPos.y - p0.position.y,
		0,
	]);
	azimuth.centerToNorth.position.copy(p0.position);
	azimuth.centerToNorth.geometry.verticesNeedUpdate = true;
	azimuth.centerToNorth.geometry.computeBoundingSphere();
	azimuth.centerToNorth.computeLineDistances();
	azimuth.centerToNorth.material.resolution.set(width, height);

	// label
	const radians = Utils.computeAzimuth(p0.position, p1.position, viewer.getProjection());
	let degrees = THREE.Math.radToDeg(radians);
	if(degrees < 0){
		degrees = 360 + degrees;
	}
	const txtDegrees = `${degrees.toFixed(2)}°`;
	const labelDir = northPos.clone().add(p1.position).multiplyScalar(0.5).sub(p0.position);
	if(labelDir.length() > 0){
		labelDir.z = 0;
		labelDir.normalize();
		const labelVec = labelDir.clone().multiplyScalar(r);
		const labelPos = p0.position.clone().add(labelVec);
		azimuth.label.position.copy(labelPos);
	}
	azimuth.label.setText(txtDegrees);
	let distance = azimuth.label.position.distanceTo(camera.position);
	let pr = Utils.projectedRadius(1, camera, distance, width, height);
	let scale = (70 / pr);
	azimuth.label.scale.set(scale, scale, scale);
}

export class MeasuringTool extends EventDispatcher{
	constructor (viewer) {
		super();

		this.viewer = viewer;
		this.renderer = viewer.renderer;

		this._editMode = false;

		this.addEventListener('start_inserting_measurement', e => {
			this.viewer.dispatchEvent({
				type: 'cancel_insertions'
			});
		});

		this.showLabels = true;
		this.scene = new THREE.Scene();
		this.scene.name = 'scene_measurement';
		this.light = new THREE.PointLight(0xffffff, 1.0);
		this.scene.add(this.light);

		// Register interactive scene (allows moving points on PC)
		this.viewer.inputHandler.registerInteractiveScene(this.scene);

		this.onRemove = (e) => { this.scene.remove(e.measurement);};
		this.onAdd = e => {this.scene.add(e.measurement);};

		for(let measurement of viewer.scene.measurements){
			this.onAdd({measurement: measurement});
		}

		viewer.addEventListener("update", this.update.bind(this));
		viewer.addEventListener("render.pass.perspective_overlay", this.render.bind(this));
		viewer.addEventListener("scene_changed", this.onSceneChange.bind(this));

		viewer.scene.addEventListener('measurement_added', this.onAdd);
		viewer.scene.addEventListener('measurement_removed', this.onRemove);
	}

	get editMode(){
		return this._editMode;
	}

	set editMode(value){
		if(this._editMode !== value){
			this._editMode = value;

			if(this.viewer && this.viewer.inputHandler){
				if(this._editMode){
					this.viewer.inputHandler.registerInteractiveScene(this.scene);
				}else{
					// Only unregister on tablet for touch safety
					if(this.viewer.isTablet){
						this.viewer.inputHandler.unregisterInteractiveScene(this.scene);
						this.viewer.inputHandler.hoveredElements = [];
						this.viewer.inputHandler.drag = null;
					}
				}
			}

			this.dispatchEvent({type: "edit_mode_changed", mode: value});
		}
	}

	onSceneChange(e){
		if(e.oldScene){
			e.oldScene.removeEventListener('measurement_added', this.onAdd);
			e.oldScene.removeEventListener('measurement_removed', this.onRemove);
		}

		e.scene.addEventListener('measurement_added', this.onAdd);
		e.scene.addEventListener('measurement_removed', this.onRemove);
	}

	startInsertion (args = {}) {
		const isTouchDevice = ('ontouchstart' in window) ||
			(navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches);
		if (isTouchDevice) {
			this.editMode = true;}
		let domElement = this.viewer.renderer.domElement;

		let measure = new Measure();

		this.dispatchEvent({
			type: 'start_inserting_measurement',
			measure: measure
		});

		const pick = (defaul, alternative) => {
			if(defaul != null){
				return defaul;
			}else{
				return alternative;
			}
		};

		measure.showDistances = (args.showDistances === null) ? true : args.showDistances;

		measure.showArea = pick(args.showArea, false);
		measure.showAngles = pick(args.showAngles, false);
		measure.showCoordinates = pick(args.showCoordinates, false);
		measure.showHeight = pick(args.showHeight, false);
		measure.showCircle = pick(args.showCircle, false);
		measure.showAzimuth = pick(args.showAzimuth, false);
		measure.showEdges = pick(args.showEdges, true);
		measure.closed = pick(args.closed, false);
		measure.maxMarkers = pick(args.maxMarkers, Infinity);

		measure.name = args.name || 'Measurement';

		this.scene.add(measure);

		let longPressTimer = null;
		let longPressTriggered = false;
		let hintDiv = null;

		const showHint = (msg) => {
			if (!hintDiv) {
				hintDiv = document.createElement('div');
				hintDiv.style.position = 'absolute';
				hintDiv.style.top = '20px';
				hintDiv.style.left = '50%';
				hintDiv.style.transform = 'translateX(-50%)';
				hintDiv.style.zIndex = 10001;
				hintDiv.style.padding = '8px 12px';
				hintDiv.style.background = 'rgba(0, 0, 0, 0.6)';
				hintDiv.style.color = '#fff';
				hintDiv.style.borderRadius = '4px';
				this.viewer.renderArea.appendChild(hintDiv);
			}
			hintDiv.textContent = msg;
			hintDiv.style.display = 'block';
		};

		const hideHint = () => {
			if (hintDiv) {
				hintDiv.style.display = 'none';
			}
		};

		const clearLongPressTimer = () => {
			if (longPressTimer) {
				clearTimeout(longPressTimer);
				longPressTimer = null;
			}
		};

		const finalizeMeasurement = () => {
			if (isTouchDevice){
				longPressTriggered = true;
				measure.closed = true;
				this.editMode = false;
				showHint(t('measure_done'));
				setTimeout(() => { hideHint(); }, 1200);
				if (this.viewer && this.viewer.inputHandler) {
					this.viewer.inputHandler.drag = null;
				}
				domElement.removeEventListener('pointerdown', onPointerDown, false);
				domElement.removeEventListener('pointermove', onPointerMove, false);
				domElement.removeEventListener('pointerup', onPointerUp, false);
				domElement.removeEventListener('pointercancel', onPointerCancel, false);
				if (this.viewer) {
					this.viewer.removeEventListener('cancel_insertions', cancel.callback);
				}
			};
		}	

		const onPointerDown = (e) => {
			if (!this.editMode) { return; }
			clearLongPressTimer();
			longPressTriggered = false;
			showHint(t('measure_hold'));
			longPressTimer = setTimeout(() => {
				finalizeMeasurement();
			}, 700);
		};

		const onPointerMove = () => {
			clearLongPressTimer();
			hideHint();
		};

		const onPointerUp = () => {
			clearLongPressTimer();
			hideHint();
		};

		const onPointerCancel = () => {
			clearLongPressTimer();
			hideHint();
		};

		if (isTouchDevice) {
			domElement.addEventListener('pointerdown', onPointerDown, false);
			domElement.addEventListener('pointermove', onPointerMove, false);
			domElement.addEventListener('pointerup', onPointerUp, false);
			domElement.addEventListener('pointercancel', onPointerCancel, false);
		}

		let cancel = {
			removeLastMarker: measure.maxMarkers > 3,
			callback: null
		};

		let insertionCallback = (e) => {
			if (longPressTriggered) {
				return;
			}

			if (e.button === THREE.MOUSE.LEFT) {
				measure.addMarker(measure.points[measure.points.length - 1].position.clone());

				if (measure.points.length >= measure.maxMarkers) {
					cancel.callback();
				}

				let newTouchSphere = measure.touchSpheres[measure.touchSpheres.length - 1] || measure.spheres[measure.spheres.length - 1];
				this.viewer.inputHandler.startDragging(newTouchSphere);
			} else if (e.button === THREE.MOUSE.RIGHT) {
				cancel.callback();
			}
		};

		cancel.callback = e => {
			if (cancel.removeLastMarker) {
				measure.removeMarker(measure.points.length - 1);
			}
			if (this.viewer && this.viewer.inputHandler) {
				this.viewer.inputHandler.drag = null;
			}
			this.editMode = false;
			domElement.removeEventListener('pointerup', insertionCallback, false);
			if (isTouchDevice) {
				domElement.removeEventListener('pointerdown', onPointerDown, false);
				domElement.removeEventListener('pointermove', onPointerMove, false);
				domElement.removeEventListener('pointerup', onPointerUp, false);
				domElement.removeEventListener('pointercancel', onPointerCancel, false);
			}
			this.viewer.removeEventListener('cancel_insertions', cancel.callback);
		};

		if (measure.maxMarkers > 1) {
			this.viewer.addEventListener('cancel_insertions', cancel.callback);
			domElement.addEventListener('pointerup', insertionCallback, false);
		}

		measure.addMarker(new THREE.Vector3(0, 0, 0));
		let touchSphere = measure.touchSpheres[measure.touchSpheres.length - 1];
		if (touchSphere) {
			this.viewer.inputHandler.startDragging(touchSphere);
		} else {
			this.viewer.inputHandler.startDragging(measure.spheres[measure.spheres.length - 1]);
		}

		this.viewer.scene.addMeasurement(measure);

		return measure;
	}
	
	update(){
		let camera = this.viewer.scene.getActiveCamera();
		let domElement = this.renderer.domElement;
		let measurements = this.viewer.scene.measurements;

		const renderAreaSize = this.renderer.getSize(new THREE.Vector2());
		let clientWidth = renderAreaSize.width;
		let clientHeight = renderAreaSize.height;

		this.light.position.copy(camera.position);

		// make size independant of distance
		for (let measure of measurements) {
			measure.lengthUnit = this.viewer.lengthUnit;
			measure.lengthUnitDisplay = this.viewer.lengthUnitDisplay;
			measure.update();

			updateAzimuth(this.viewer, measure);

			// spheres
			for(let sphere of measure.spheres){
				let distance = camera.position.distanceTo(sphere.getWorldPosition(new THREE.Vector3()));
				let pr = Utils.projectedRadius(1, camera, distance, clientWidth, clientHeight);
				let scale = (15 / pr);
				sphere.scale.set(scale, scale, scale);
			}

			// touch spheres
			if (measure.touchSpheres){
				for(let i = 0; i < measure.touchSpheres.length; i++){
					let touchSphere = measure.touchSpheres[i];
					let sphere = measure.spheres[i];
					if(!touchSphere || !sphere) continue;
					touchSphere.position.copy(sphere.position);
					touchSphere.scale.copy(sphere.scale).multiplyScalar(2.2);
				}
			}

			// labels
			let labels = measure.edgeLabels.concat(measure.angleLabels);
			for(let label of labels){
				let distance = camera.position.distanceTo(label.getWorldPosition(new THREE.Vector3()));
				let pr = Utils.projectedRadius(1, camera, distance, clientWidth, clientHeight);
				let scale = (70 / pr);

				if(Potree.debug.scale){
					scale = (Potree.debug.scale / pr);
				}

				label.scale.set(scale, scale, scale);
			}

			// coordinate labels
			for (let j = 0; j < measure.coordinateLabels.length; j++) {
				let label = measure.coordinateLabels[j];
				let sphere = measure.spheres[j];

				let distance = camera.position.distanceTo(sphere.getWorldPosition(new THREE.Vector3()));

				let screenPos = sphere.getWorldPosition(new THREE.Vector3()).clone().project(camera);
				screenPos.x = Math.round((screenPos.x + 1) * clientWidth / 2);
				screenPos.y = Math.round((-screenPos.y + 1) * clientHeight / 2);
				screenPos.z = 0;
				screenPos.y -= 30;

				let labelPos = new THREE.Vector3( 
					(screenPos.x / clientWidth) * 2 - 1, 
					-(screenPos.y / clientHeight) * 2 + 1, 
					0.5 );
				labelPos.unproject(camera);
				if(this.viewer.scene.cameraMode == CameraMode.PERSPECTIVE) {
					let direction = labelPos.sub(camera.position).normalize();
					labelPos = new THREE.Vector3().addVectors(
						camera.position, direction.multiplyScalar(distance));

				}
				label.position.copy(labelPos);
				let pr = Utils.projectedRadius(1, camera, distance, clientWidth, clientHeight);
				let scale = (70 / pr);
				label.scale.set(scale, scale, scale);
			}

			// height label
			if (measure.showHeight) {
				let label = measure.heightLabel;

				{
					let distance = label.position.distanceTo(camera.position);
					let pr = Utils.projectedRadius(1, camera, distance, clientWidth, clientHeight);
					let scale = (70 / pr);
					label.scale.set(scale, scale, scale);
				}

				{ // height edge
					let edge = measure.heightEdge;

					let sorted = measure.points.slice().sort((a, b) => a.position.z - b.position.z);
					let lowPoint = sorted[0].position.clone();
					let highPoint = sorted[sorted.length - 1].position.clone();
					let min = lowPoint.z;
					let max = highPoint.z;

					let start = new THREE.Vector3(highPoint.x, highPoint.y, min);
					let end = new THREE.Vector3(highPoint.x, highPoint.y, max);

					let lowScreen = lowPoint.clone().project(camera);
					let startScreen = start.clone().project(camera);
					let endScreen = end.clone().project(camera);

					let toPixelCoordinates = v => {
						let r = v.clone().addScalar(1).divideScalar(2);
						r.x = r.x * clientWidth;
						r.y = r.y * clientHeight;
						r.z = 0;

						return r;
					};

					let lowEL = toPixelCoordinates(lowScreen);
					let startEL = toPixelCoordinates(startScreen);
					let endEL = toPixelCoordinates(endScreen);

					let lToS = lowEL.distanceTo(startEL);
					let sToE = startEL.distanceTo(endEL);

					edge.geometry.lineDistances = [0, lToS, lToS, lToS + sToE];
					edge.geometry.lineDistancesNeedUpdate = true;

					edge.material.dashSize = 10;
					edge.material.gapSize = 10;
				}
			}

			{ // area label
				let label = measure.areaLabel;
				let distance = label.position.distanceTo(camera.position);
				let pr = Utils.projectedRadius(1, camera, distance, clientWidth, clientHeight);

				let scale = (70 / pr);
				label.scale.set(scale, scale, scale);
			}

			{ // radius label
				let label = measure.circleRadiusLabel;
				let distance = label.position.distanceTo(camera.position);
				let pr = Utils.projectedRadius(1, camera, distance, clientWidth, clientHeight);

				let scale = (70 / pr);
				label.scale.set(scale, scale, scale);
			}

			{ // edges
				const materials = [
					measure.circleRadiusLine.material,
					...measure.edges.map( (e) => e.material),
					measure.heightEdge.material,
					measure.circleLine.material,
				];

				for(const material of materials){
					material.resolution.set(clientWidth, clientHeight);
				}
			}

			if(!this.showLabels){

				const labels = [
					...measure.sphereLabels, 
					...measure.edgeLabels, 
					...measure.angleLabels, 
					...measure.coordinateLabels,
					measure.heightLabel,
					measure.areaLabel,
					measure.circleRadiusLabel,
				];

				for(const label of labels){
					label.visible = false;
				}
			}
		}
	}

	render(){
		this.viewer.renderer.render(this.scene, this.viewer.scene.getActiveCamera());
	}
};

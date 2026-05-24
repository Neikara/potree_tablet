
import * as THREE from "../../libs/three.js/build/three.module.js";
import {Profile} from "./Profile.js";
import {Utils} from "../utils.js";
import { EventDispatcher } from "../EventDispatcher.js";
import { t } from "../i18n.js";


export class ProfileTool extends EventDispatcher {
	constructor (viewer) {
		super();

			this.viewer = viewer;
		this.renderer = viewer.renderer;
		this._editMode = false;

		this.addEventListener('start_inserting_profile', e => {
			this.viewer.dispatchEvent({
				type: 'cancel_insertions'
			});
		});

		this.scene = new THREE.Scene();
		this.scene.name = 'scene_profile';
		this.light = new THREE.PointLight(0xffffff, 1.0);
		this.scene.add(this.light);

		// Interactive scene should be registered only in edit mode (touch-safe)
		this.viewer.inputHandler.registerInteractiveScene(this.scene);

		this.onRemove = e => this.scene.remove(e.profile);
		this.onAdd = e => this.scene.add(e.profile);

		for(let profile of viewer.scene.profiles){
			this.onAdd({profile: profile});
		}

		viewer.addEventListener("update", this.update.bind(this));
		viewer.addEventListener("render.pass.perspective_overlay", this.render.bind(this));
		viewer.addEventListener("scene_changed", this.onSceneChange.bind(this));

		viewer.scene.addEventListener('profile_added', this.onAdd);
		viewer.scene.addEventListener('profile_removed', this.onRemove);
	}

	onSceneChange(e){
		if(e.oldScene){
			e.oldScene.removeEventListener('profile_added', this.onAdd);
			e.oldScene.removeEventListener('profile_removed', this.onRemove);
		}

		e.scene.addEventListener('profile_added', this.onAdd);
		e.scene.addEventListener('profile_removed', this.onRemove);
	}

	get editMode(){
		return this._editMode;
	}

	set editMode(value){
		if (this._editMode === value) return;

		this._editMode = value;

		if(this.viewer && this.viewer.inputHandler){
			if(value){
				this.viewer.inputHandler.registerInteractiveScene(this.scene);
			}else{
				if(this.viewer.isTablet){
					this.viewer.inputHandler.unregisterInteractiveScene(this.scene);
					this.viewer.inputHandler.hoveredElements = [];
					this.viewer.inputHandler.drag = null;
				}
			}
		}
		this.dispatchEvent({type: 'edit_mode_changed', mode: value});
	}

	startInsertion (args = {}) {
		const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
		if (isTouchDevice) {
			this.editMode = true;}
		let domElement = this.viewer.renderer.domElement;

		let profile = new Profile();
		profile.name = args.name || 'Profile';

		this.dispatchEvent({
			type: 'start_inserting_profile',
			profile: profile
		});

		this.scene.add(profile);

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

		const finalizeProfile = () => {
			if (isTouchDevice){
				console.log(this.editMode);
				longPressTriggered = true;
				this.editMode = false;
				showHint(t('profile_done'));
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
				console.log(this.editMode);
			};
		};

		const onPointerDown = () => {
			if (!this.editMode) { return; }
			clearLongPressTimer();
			longPressTriggered = false;
			showHint(t('profile_hold'));
			longPressTimer = setTimeout(() => {
				finalizeProfile();
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

		domElement.addEventListener('pointerdown', onPointerDown, false);
		domElement.addEventListener('pointermove', onPointerMove, false);
		domElement.addEventListener('pointerup', onPointerUp, false);
		domElement.addEventListener('pointercancel', onPointerCancel, false);

		let cancel = {
			callback: null
		};

		let insertionCallback = (e) => {
			if(longPressTriggered){
				return;
			}

			if(e.button === THREE.MOUSE.LEFT){
				if(profile.points.length <= 1){
					let camera = this.viewer.scene.getActiveCamera();
					let distance = camera.position.distanceTo(profile.points[0]);
					let clientSize = this.viewer.renderer.getSize(new THREE.Vector2());
					let pr = Utils.projectedRadius(1, camera, distance, clientSize.width, clientSize.height);
					let width = (10 / pr);

					profile.setWidth(width);
				}

				profile.addMarker(profile.points[profile.points.length - 1].clone());

				this.viewer.inputHandler.startDragging(
					profile.spheres[profile.spheres.length - 1]);
			} else if (e.button === THREE.MOUSE.RIGHT) {
				cancel.callback();
			}
		};

		cancel.callback = e => {
			profile.removeMarker(profile.points.length - 1);
			clearLongPressTimer();
			hideHint();
			if (this.viewer && this.viewer.inputHandler) {
				this.viewer.inputHandler.drag = null;
			}
			this.editMode = false;
			domElement.removeEventListener('pointerup', insertionCallback, false);
			domElement.removeEventListener('pointerdown', onPointerDown, false);
			domElement.removeEventListener('pointermove', onPointerMove, false);
			domElement.removeEventListener('pointerup', onPointerUp, false);
			domElement.removeEventListener('pointercancel', onPointerCancel, false);
			this.viewer.removeEventListener('cancel_insertions', cancel.callback);
		};

		this.viewer.addEventListener('cancel_insertions', cancel.callback);
		domElement.addEventListener('pointerup', insertionCallback, false);

		this.viewer.scene.addProfile(profile);
		profile.addMarker(new THREE.Vector3(0, 0, 0));
		this.viewer.inputHandler.startDragging(
			profile.spheres[profile.spheres.length - 1]);

		return profile;
	}

	update(){
		let camera = this.viewer.scene.getActiveCamera();
		let profiles = this.viewer.scene.profiles;
		let renderAreaSize = this.viewer.renderer.getSize(new THREE.Vector2());
		let clientWidth = renderAreaSize.width;
		let clientHeight = renderAreaSize.height;

		this.light.position.copy(camera.position);

		// make size independant of distance
		for(let profile of profiles){
			for(let sphere of profile.spheres){				
				let distance = camera.position.distanceTo(sphere.getWorldPosition(new THREE.Vector3()));
				let pr = Utils.projectedRadius(1, camera, distance, clientWidth, clientHeight);
				let scale = (15 / pr);
				sphere.scale.set(scale, scale, scale);
			}
		}
	}

	render(){
		this.viewer.renderer.render(this.scene, this.viewer.scene.getActiveCamera());
	}

}


const translations = {
	fr: {
		menu_settings:    'Paramètres',
		menu_tools:       'Outils',
		mode_explore:     'Explorer',
		mode_teleport:    'Téléportation',
		mode_manipulate:  'Manipuler',
		mode_orbit:       'Orbitale',
		btn_reset:        '↺ Reset Vue',
		btn_clear:        '🗑 Supprimer les Mesures',
		btn_swap:         '⇄ Exchanger de Main principale',
		btn_realsize:     '⬛ Taille Réelle',
		btn_lang:         'Langue: FR',
		measure_done:     'Mesure terminée',
		measure_hold:     'Maintenir pour terminer...',
		profile_done:     'Profil terminé',
		profile_hold:     'Maintenir pour clore...',
	},
	en: {
		menu_settings:    'Settings',
		menu_tools:       'Tools',
		mode_explore:     'Explore',
		mode_teleport:    'Teleport',
		mode_manipulate:  'Manipulate',
		mode_orbit:       'Orbit',
		btn_reset:        '↺ Reset View',
		btn_clear:        '🗑 Clear Measures',
		btn_swap:         '⇄ Swap Hands',
		btn_realsize:     '⬛ Real Size',
		btn_lang:         'Language: EN',
		measure_done:     'Measurement done',
		measure_hold:     'Hold to finish...',
		profile_done:     'Profile done',
		profile_hold:     'Hold to close...',
	},
};

let _lang = 'fr';
const _listeners = [];

export function t(key) {
	return (translations[_lang] && translations[_lang][key]) || key;
}

export function setLanguage(lang) {
	if (!translations[lang] || lang === _lang) return;
	_lang = lang;
	_listeners.forEach(fn => fn(lang));
}

export function getLanguage() {
	return _lang;
}

export function onLanguageChange(fn) {
	_listeners.push(fn);
}

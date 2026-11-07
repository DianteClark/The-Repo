// Tidefall 3.0 cosmetics catalog (shared by Graphics and UI).
//
// Pure data, no rendering. Graphics renders every id listed here (skins in
// gfx/units.js + gfx/skins.js, kill effects and drop-ins in gfx/cosmeticfx.js);
// UI sells and equips them. Prices are in Salvage.
//
// Rules the renderer keeps for every skin: it never changes a class
// silhouette, and never touches the squad-colour ring, visor or armband.

export const RARITY = {
  common: { label: 'Common', color: '#b9c4c2', order: 0 },
  rare: { label: 'Rare', color: '#5aa8ff', order: 1 },
  epic: { label: 'Epic', color: '#c46bff', order: 2 },
  legendary: { label: 'Legendary', color: '#ffcf4a', order: 3 },
};

// swatch: two or three colours UI can use for a card chip when no preview is drawn.
export const COSMETICS = {
  skins: [
    { id: 'default', name: 'Standard Issue', rarity: 'common', price: 0, classes: 'all', desc: 'Faded field kit, patched and salt-stained.', swatch: ['#86a3a6', '#56706f'] },
    { id: 'tidewater', name: 'Tidewater', rarity: 'common', price: 150, classes: 'all', desc: 'Navy deck fatigues with sailor stripes.', swatch: ['#2b3f63', '#e7e1cf'] },
    { id: 'sandstorm', name: 'Sandstorm', rarity: 'common', price: 150, classes: 'all', desc: 'Dune-tan camo for the dry atolls.', swatch: ['#c8a873', '#8a6d44'] },
    { id: 'kelpie', name: 'Kelpie', rarity: 'common', price: 250, classes: 'all', desc: 'Blotched kelp-bed camo. Smells like low tide.', swatch: ['#3f6b45', '#22402c'] },
    { id: 'arctic', name: 'Whiteout', rarity: 'rare', price: 450, classes: 'all', desc: 'Digital snow camo from a station that drowned long ago.', swatch: ['#e6ebee', '#8c99a3'] },
    { id: 'rustbucket', name: 'Rustbucket', rarity: 'rare', price: 500, classes: 'all', desc: 'Plates welded from hull scrap. Flaking orange.', swatch: ['#a4512c', '#5c3220'] },
    { id: 'nightops', name: 'Night Ops', rarity: 'rare', price: 650, classes: 'all', desc: 'Matte black with charcoal webbing.', swatch: ['#202428', '#3a4046'] },
    { id: 'tigershark', name: 'Tiger Shark', rarity: 'epic', price: 1100, classes: 'all', desc: 'Slate grey with bold predator stripes.', swatch: ['#6d7880', '#1b2024'] },
    { id: 'coral', name: 'Reef Bleach', rarity: 'epic', price: 1250, classes: 'all', desc: 'Coral pink and reef teal, hand-painted.', swatch: ['#f08a7e', '#2f8f8a'] },
    { id: 'synthwave', name: 'Synthwave', rarity: 'epic', price: 1450, classes: 'all', desc: 'Dark kit with glowing violet seams.', swatch: ['#1a1430', '#c04dff'] },
    { id: 'gilded', name: 'Gilded Salvage', rarity: 'legendary', price: 2500, classes: 'all', desc: 'Polished gold plate over black. Loud. Expensive.', swatch: ['#e9c25a', '#1c1a17'] },
    { id: 'abyssal', name: 'Abyssal', rarity: 'legendary', price: 2400, classes: 'all', desc: 'Deep-sea black with pulsing bioluminescent spots.', swatch: ['#0b1a2e', '#5bffb0'] },
    { id: 'holo', name: 'Prism Holo', rarity: 'legendary', price: 2500, classes: 'all', desc: 'Iridescent plating that shifts hue as you move.', swatch: ['#ff7ad9', '#7aa8ff', '#9dffb0'] },
  ],
  killFx: [
    { id: 'default', name: 'None', rarity: 'common', price: 0, desc: 'A clean, quiet takedown.', swatch: ['#c9d2d0', '#6f7a7a'] },
    { id: 'tidal', name: 'Tidal Splash', rarity: 'common', price: 200, desc: 'A column of seawater bursts from the ground.', swatch: ['#5fd3c3', '#eef8f1'] },
    { id: 'ember', name: 'Ember Burst', rarity: 'rare', price: 500, desc: 'A shower of hot embers and a smoke ring.', swatch: ['#ff7a2a', '#3a2a22'] },
    { id: 'kelp', name: 'Kelp Bloom', rarity: 'rare', price: 550, desc: 'Kelp fronds erupt and sway, then wilt.', swatch: ['#3f8a4a', '#9fd36b'] },
    { id: 'coins', name: 'Salvage Jackpot', rarity: 'epic', price: 1200, desc: 'A fountain of gold salvage coins.', swatch: ['#ffd24a', '#9a6a12'] },
    { id: 'glitch', name: 'Holo Glitch', rarity: 'epic', price: 1300, desc: 'The target derezzes into glitching voxels.', swatch: ['#ff4fd8', '#6a7bff'] },
    { id: 'lightning', name: 'Thunderstrike', rarity: 'legendary', price: 2200, desc: 'A lightning bolt from a clear sky.', swatch: ['#f0f4ff', '#8a9cff'] },
    { id: 'ink', name: 'Kraken Ink', rarity: 'legendary', price: 2300, desc: 'Tentacles of ink lash up and swallow the fall.', swatch: ['#15121c', '#5a3f8a'] },
  ],
  dropIns: [
    { id: 'default', name: 'Drop Pod Hop', rarity: 'common', price: 0, desc: 'A short hop from a low-flying transport.', swatch: ['#c9d2d0', '#6f7a7a'] },
    { id: 'parachute', name: 'Parachute', rarity: 'common', price: 250, desc: 'Floats down under a striped canopy.', swatch: ['#e5dcc6', '#2e7d7a'] },
    { id: 'boat', name: 'Beach Landing', rarity: 'rare', price: 600, desc: 'Rides a dinghy in and hops over the bow.', swatch: ['#3e5f7d', '#e0d4b6'] },
    { id: 'grapple', name: 'Gunship Grapple', rarity: 'rare', price: 700, desc: 'Ropes down from a hovering gunship.', swatch: ['#353b3e', '#a4452c'] },
    { id: 'breach', name: 'Sea Breach', rarity: 'epic', price: 1300, desc: 'Erupts from the water in a plume of spray.', swatch: ['#1f8d98', '#eef8f1'] },
    { id: 'orbital', name: 'Orbital Beacon', rarity: 'legendary', price: 2400, desc: 'Beamed down from orbit in a pillar of light.', swatch: ['#f4f0ff', '#8a7bff'] },
    { id: 'gulls', name: 'Gull Flock', rarity: 'legendary', price: 2200, desc: 'A spiral of gulls scatters to reveal them.', swatch: ['#f3efe4', '#3a3f42'] },
  ],
};

export const DEFAULT_LOADOUT = { skin: 'default', killFx: 'default', dropIn: 'default' };

const SLOT_KEY = { skin: 'skins', skins: 'skins', killFx: 'killFx', dropIn: 'dropIns', dropIns: 'dropIns' };

/** Look up an item: slot is 'skin' | 'killFx' | 'dropIn' (or the plural catalog key). */
export function findCosmetic(slot, id) {
  const list = COSMETICS[SLOT_KEY[slot]];
  if (!list) return null;
  return list.find((c) => c.id === id) || null;
}

/** A loadout with every unknown id replaced by 'default'. */
export function sanitizeLoadout(l) {
  const o = l || {};
  return {
    skin: findCosmetic('skin', o.skin) ? o.skin : 'default',
    killFx: findCosmetic('killFx', o.killFx) ? o.killFx : 'default',
    dropIn: findCosmetic('dropIn', o.dropIn) ? o.dropIn : 'default',
  };
}

/**
 * Random loadout for a bot. `rnd` is a () => [0,1) function (Math.random by
 * default). Cheaper items are more common, and some bots stay on defaults.
 */
export function randomLoadout(rnd = Math.random) {
  const pick = (list) => {
    if (rnd() < 0.3) return 'default';
    const w = list.map((c) => (c.id === 'default' ? 0 : 1 / (1 + RARITY[c.rarity].order * 0.9)));
    let r = rnd() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < list.length; i++) { if ((r -= w[i]) < 0) return list[i].id; }
    return 'default';
  };
  return { skin: pick(COSMETICS.skins), killFx: pick(COSMETICS.killFx), dropIn: pick(COSMETICS.dropIns) };
}

// Tidefall 5.0 cosmetics catalog (shared by Graphics and UI).
//
// Pure data, no rendering. Graphics renders every id listed here:
//   skins        gfx/units.js + gfx/skins.js
//   killFx       gfx/cosmeticfx.js  CosmeticFx.killEffect(id, view)
//   dropIns      gfx/cosmeticfx.js  CosmeticFx.dropIn(id, view, goal)
//   emotes       gfx/units.js       SoldierView.playEmote(id)
//   charms       gfx/weapons.js     (hung on the weapon; SoldierView opts.charm)
//   tracers      gfx/cosmeticfx.js  CosmeticFx.tracer(id, ...)
//   streakSkins  gfx/cosmeticfx.js  buildStreakModel(kind, id) / streakLook(id)
//   CAMOS        gfx/camos.js       makeCamoMaterial(id)  (earned, not sold)
// UI sells and equips them. Prices are in Salvage. Every slot has a free
// 'default' item. All 3.0 ids still exist with the same meaning.
//
// Rules the renderer keeps for every skin: it never changes a class
// silhouette, and never touches the squad-colour ring, visor or armband.
// Tracer cosmetics only change the core and trail: the outer beam keeps the
// shooter's squad colour so fire stays readable.

export const RARITY = {
  common: { label: 'Common', color: '#b9c4c2', order: 0 },
  rare: { label: 'Rare', color: '#5aa8ff', order: 1 },
  epic: { label: 'Epic', color: '#c46bff', order: 2 },
  legendary: { label: 'Legendary', color: '#ffcf4a', order: 3 },
};

// swatch: two or three colours UI can use for a card chip when no preview is drawn.
// operator (skins only, optional): { callsign, name, bio } short backstory for the store page.
export const COSMETICS = {
  skins: [
    { id: 'default', name: 'Standard Issue', rarity: 'common', price: 0, classes: 'all', desc: 'Faded field kit, patched and salt-stained.', swatch: ['#86a3a6', '#56706f'] },
    { id: 'tidewater', name: 'Tidewater', rarity: 'common', price: 150, classes: 'all', desc: 'Navy deck fatigues with sailor stripes.', swatch: ['#2b3f63', '#e7e1cf'] },
    { id: 'sandstorm', name: 'Sandstorm', rarity: 'common', price: 150, classes: 'all', desc: 'Dune-tan camo for the dry atolls.', swatch: ['#c8a873', '#8a6d44'] },
    { id: 'op_splinter', name: 'Splinter', rarity: 'common', price: 200, classes: 'all', desc: 'Grey urban splinter camo from the flooded city blocks.', swatch: ['#8f969a', '#3e4448', '#c5c9c6'],
      operator: { callsign: 'SPLINTER', name: 'Tomas Vry', bio: 'Ran rooftops in the drowned capital until the rooftops went under too. Still moves like the floor might give.' } },
    { id: 'op_monsoon', name: 'Monsoon', rarity: 'common', price: 200, classes: 'all', desc: 'Storm-slate rain gear streaked with runoff.', swatch: ['#4a5868', '#9fb3c4'],
      operator: { callsign: 'MONSOON', name: 'Priya Adebayo', bio: 'Weather officer on the last tide station. She calls the storms before the sirens do.' } },
    { id: 'kelpie', name: 'Kelpie', rarity: 'common', price: 250, classes: 'all', desc: 'Blotched kelp-bed camo. Smells like low tide.', swatch: ['#3f6b45', '#22402c'] },
    { id: 'op_hazard', name: 'Breakwater', rarity: 'common', price: 300, classes: 'all', desc: 'Dock-crew orange with black-and-yellow hazard bands.', swatch: ['#e0762a', '#f2c230', '#1d1d1d'],
      operator: { callsign: 'BREAKWATER', name: 'Gus Hallorann', bio: 'Forty years loading container ships. When the harbour drowned he kept the cranes running for the evacuation.' } },
    { id: 'arctic', name: 'Whiteout', rarity: 'rare', price: 450, classes: 'all', desc: 'Digital snow camo from a station that drowned long ago.', swatch: ['#e6ebee', '#8c99a3'] },
    { id: 'op_lighthouse', name: 'Keeper', rarity: 'rare', price: 500, classes: 'all', desc: 'Red-and-white lighthouse bands. Hard to miss, on purpose.', swatch: ['#f1ece0', '#c8322c'],
      operator: { callsign: 'KEEPER', name: 'Ines Mardoc', bio: 'Kept the Spire light burning through three surges. Paints her kit like the tower so her squad can always find her.' } },
    { id: 'rustbucket', name: 'Rustbucket', rarity: 'rare', price: 500, classes: 'all', desc: 'Plates welded from hull scrap. Flaking orange.', swatch: ['#a4512c', '#5c3220'] },
    { id: 'op_moray', name: 'Moray', rarity: 'rare', price: 550, classes: 'all', desc: 'Eel-skin green with sulphur speckles.', swatch: ['#3d5a2a', '#c8c040'],
      operator: { callsign: 'MORAY', name: 'Dmitri Sel', bio: 'Reef diver turned ambusher. Waits in the kelp for hours, then strikes once.' } },
    { id: 'op_carbon', name: 'Hex', rarity: 'rare', price: 600, classes: 'all', desc: 'Carbon hex plating over graphite fatigues.', swatch: ['#2c3034', '#5d666c'],
      operator: { callsign: 'HEX', name: 'Wen Aldous', bio: 'Built her own armour from a sunken sailboat\'s carbon hull. Lighter than steel, and twice as stubborn.' } },
    { id: 'op_ghillie', name: 'Seagrass', rarity: 'rare', price: 650, classes: 'all', desc: 'Shaggy dune-grass ghillie threads.', swatch: ['#8d9a55', '#5a6a32'],
      operator: { callsign: 'SEAGRASS', name: 'Ola Fenn', bio: 'Grew up on the dune islands. Nobody has ever seen her first shot coming.' } },
    { id: 'nightops', name: 'Night Ops', rarity: 'rare', price: 650, classes: 'all', desc: 'Matte black with charcoal webbing.', swatch: ['#202428', '#3a4046'] },
    { id: 'op_scrap', name: 'Scrapjaw', rarity: 'rare', price: 700, classes: 'all', desc: 'Mismatched patchwork plates, riveted on the fly.', swatch: ['#6c7a62', '#a0663a', '#5a6c80'],
      operator: { callsign: 'SCRAPJAW', name: '"Jaw" Okonkwo', bio: 'Salvager of the Rig Graveyard. Every plate he wears came off something that tried to kill him.' } },
    { id: 'tigershark', name: 'Tiger Shark', rarity: 'epic', price: 1100, classes: 'all', desc: 'Slate grey with bold predator stripes.', swatch: ['#6d7880', '#1b2024'] },
    { id: 'op_koi', name: 'Koi', rarity: 'epic', price: 1150, classes: 'all', desc: 'Pearl white with koi-orange blotches and ink edges.', swatch: ['#f2ede4', '#ef6a2a', '#1a1a1a'],
      operator: { callsign: 'KOI', name: 'Haru Ishida', bio: 'Former garden-keeper of the floating temple. Patient as still water, fast as a strike.' } },
    { id: 'coral', name: 'Reef Bleach', rarity: 'epic', price: 1250, classes: 'all', desc: 'Coral pink and reef teal, hand-painted.', swatch: ['#f08a7e', '#2f8f8a'] },
    { id: 'op_dazzle', name: 'Dazzle', rarity: 'epic', price: 1250, classes: 'all', desc: 'Naval dazzle stripes that break up your outline.', swatch: ['#f2f2ee', '#1b1d22', '#5b7ea8'],
      operator: { callsign: 'DAZZLE', name: 'Cmdr. Lyle Brandt', bio: 'Painted the old fleet to confuse rangefinders. Now he paints himself.' } },
    { id: 'op_brine', name: 'Brine', rarity: 'epic', price: 1300, classes: 'all', desc: 'Deep-teal wetsuit crusted with sea salt, orange trim.', swatch: ['#16484e', '#ff8a3a', '#d8e4e0'],
      operator: { callsign: 'BRINE', name: 'Saoirse Kell', bio: 'Salvage diver who went down to the drowned vault and came back with the codes. And a grudge.' } },
    { id: 'op_redtide', name: 'Red Tide', rarity: 'epic', price: 1350, classes: 'all', desc: 'Crimson algae bloom that glows faintly in the dark.', swatch: ['#5a1418', '#ff4a3a'],
      operator: { callsign: 'RED TIDE', name: 'Marek Vohl', bio: 'Survived a night in the toxic bloom on Kelp Shallows. Some say it never washed off.' } },
    { id: 'synthwave', name: 'Synthwave', rarity: 'epic', price: 1450, classes: 'all', desc: 'Dark kit with glowing violet seams.', swatch: ['#1a1430', '#c04dff'] },
    { id: 'op_frost', name: 'Hoarfrost', rarity: 'epic', price: 1450, classes: 'all', desc: 'Ice-blue plating with glowing frost crystals.', swatch: ['#cfe6f2', '#5aa8ff'],
      operator: { callsign: 'HOARFROST', name: 'Anja Lindqvist', bio: 'Last crew member of the polar relay. Walked out across the sea ice when the station went dark.' } },
    { id: 'op_circuit', name: 'Relay', rarity: 'epic', price: 1500, classes: 'all', desc: 'Signals black with live lime circuit traces.', swatch: ['#121a14', '#9dff3a'],
      operator: { callsign: 'RELAY', name: 'Kofi "Relay" Mensah', bio: 'Hacked the tide-warning grid to keep it running after the government left. Hears everything on every channel.' } },
    { id: 'op_sunset', name: 'Last Light', rarity: 'epic', price: 1500, classes: 'all', desc: 'Sunset gradient from tangerine to dusk violet.', swatch: ['#ffb36a', '#ff5a7a', '#4a2a7a'],
      operator: { callsign: 'LAST LIGHT', name: 'Rosa Ventura', bio: 'The ferry captain who made the final run off the mainland. She never says how many she carried.' } },
    { id: 'gilded', name: 'Gilded Salvage', rarity: 'legendary', price: 2500, classes: 'all', desc: 'Polished gold plate over black. Loud. Expensive.', swatch: ['#e9c25a', '#1c1a17'] },
    { id: 'abyssal', name: 'Abyssal', rarity: 'legendary', price: 2400, classes: 'all', desc: 'Deep-sea black with pulsing bioluminescent spots.', swatch: ['#0b1a2e', '#5bffb0'] },
    { id: 'holo', name: 'Prism Holo', rarity: 'legendary', price: 2500, classes: 'all', desc: 'Iridescent plating that shifts hue as you move.', swatch: ['#ff7ad9', '#7aa8ff', '#9dffb0'] },
    { id: 'op_cinder', name: 'Cinder', rarity: 'legendary', price: 2600, classes: 'all', desc: 'Charred plates over molten cracks that pulse with heat.', swatch: ['#1a1412', '#ff6a1a', '#ffd04a'],
      operator: { callsign: 'CINDER', name: 'Vasco Reyes', bio: 'Rig firefighter who walked out of the burning Graveyard platform. The armour is still warm.' } },
    { id: 'op_admiral', name: 'Admiral', rarity: 'legendary', price: 2600, classes: 'all', desc: 'Dress whites with braided gold trim. Command presence.', swatch: ['#f4f2ea', '#d8b048', '#1c2a4a'],
      operator: { callsign: 'ADMIRAL', name: 'Adm. Helena Strand', bio: 'Commanded the last fleet until there were no ports left to defend. Now she commands whoever is still standing.' } },
    { id: 'op_wraith', name: 'Wraith', rarity: 'legendary', price: 2700, classes: 'all', desc: 'Pale spectral kit with a cold glow at every edge.', swatch: ['#c8d4dc', '#8fb8ff'],
      operator: { callsign: 'WRAITH', name: 'Unknown', bio: 'Listed as drowned in the first surge. Squads keep reporting a pale figure walking out of the fog.' } },
    { id: 'op_obsidian', name: 'Obsidian', rarity: 'legendary', price: 2800, classes: 'all', desc: 'Volcanic black glass with a violet oil-slick sheen.', swatch: ['#0c0a10', '#7a4dff', '#2ad0c0'],
      operator: { callsign: 'OBSIDIAN', name: 'Nyx Calder', bio: 'Nobody knows which island she came from. Her armour was cut from the black glass of a drowned volcano.' } },
  ],
  killFx: [
    { id: 'default', name: 'None', rarity: 'common', price: 0, desc: 'A clean, quiet takedown.', swatch: ['#c9d2d0', '#6f7a7a'] },
    { id: 'tidal', name: 'Tidal Splash', rarity: 'common', price: 200, desc: 'A column of seawater bursts from the ground.', swatch: ['#5fd3c3', '#eef8f1'] },
    { id: 'bubbles', name: 'Last Breath', rarity: 'common', price: 200, desc: 'A rush of glittering bubbles floats skyward.', swatch: ['#bfeaf2', '#4aa0c0'] },
    { id: 'sonar', name: 'Sonar Ping', rarity: 'common', price: 250, desc: 'Three expanding sonar rings and a contact blip.', swatch: ['#9dff9a', '#14301c'] },
    { id: 'ember', name: 'Ember Burst', rarity: 'rare', price: 500, desc: 'A shower of hot embers and a smoke ring.', swatch: ['#ff7a2a', '#3a2a22'] },
    { id: 'kelp', name: 'Kelp Bloom', rarity: 'rare', price: 550, desc: 'Kelp fronds erupt and sway, then wilt.', swatch: ['#3f8a4a', '#9fd36b'] },
    { id: 'firework', name: 'Flare Show', rarity: 'rare', price: 600, desc: 'Signal flares launch and pop into star bursts.', swatch: ['#ff4a6a', '#ffd04a', '#6ad0ff'] },
    { id: 'pixel', name: '8-Bit', rarity: 'rare', price: 650, desc: 'Breaks apart into chunky retro pixels.', swatch: ['#ff5a5a', '#5aff7a', '#5a8aff'] },
    { id: 'coins', name: 'Salvage Jackpot', rarity: 'epic', price: 1200, desc: 'A fountain of gold salvage coins.', swatch: ['#ffd24a', '#9a6a12'] },
    { id: 'glitch', name: 'Holo Glitch', rarity: 'epic', price: 1300, desc: 'The target derezzes into glitching voxels.', swatch: ['#ff4fd8', '#6a7bff'] },
    { id: 'shatter', name: 'Flash Freeze', rarity: 'epic', price: 1350, desc: 'Frozen solid, then shattered into ice shards.', swatch: ['#dff4ff', '#7ac0ff'] },
    { id: 'sharks', name: 'Feeding Frenzy', rarity: 'epic', price: 1400, desc: 'Shark fins circle in a churning whirlpool.', swatch: ['#5a6a78', '#2a8aa0'] },
    { id: 'skull', name: 'Jolly Roger', rarity: 'epic', price: 1450, desc: 'A grinning smoke skull rises from the fall.', swatch: ['#e8e4d8', '#1a1a1a'] },
    { id: 'lightning', name: 'Thunderstrike', rarity: 'legendary', price: 2200, desc: 'A lightning bolt from a clear sky.', swatch: ['#f0f4ff', '#8a9cff'] },
    { id: 'ink', name: 'Kraken Ink', rarity: 'legendary', price: 2300, desc: 'Tentacles of ink lash up and swallow the fall.', swatch: ['#15121c', '#5a3f8a'] },
    { id: 'anchor', name: 'Dropped Anchor', rarity: 'legendary', price: 2400, desc: 'A giant ship\'s anchor slams down from the sky.', swatch: ['#3a4246', '#c8b070'] },
    { id: 'maelstrom', name: 'Maelstrom', rarity: 'legendary', price: 2600, desc: 'A violet vortex tears open and pulls them under.', swatch: ['#2a1450', '#b46aff', '#6ad0ff'] },
  ],
  dropIns: [
    { id: 'default', name: 'Drop Pod Hop', rarity: 'common', price: 0, desc: 'A short hop from a low-flying transport.', swatch: ['#c9d2d0', '#6f7a7a'] },
    { id: 'parachute', name: 'Parachute', rarity: 'common', price: 250, desc: 'Floats down under a striped canopy.', swatch: ['#e5dcc6', '#2e7d7a'] },
    { id: 'zipline', name: 'Zipline', rarity: 'common', price: 300, desc: 'Slides in on a cable from far off.', swatch: ['#5a6266', '#ffb000'] },
    { id: 'boat', name: 'Beach Landing', rarity: 'rare', price: 600, desc: 'Rides a dinghy in and hops over the bow.', swatch: ['#3e5f7d', '#e0d4b6'] },
    { id: 'jetski', name: 'Jet Ski', rarity: 'rare', price: 650, desc: 'Skids in on a jet ski, spraying a rooster tail.', swatch: ['#ff4a3a', '#f4f2ea'] },
    { id: 'grapple', name: 'Gunship Grapple', rarity: 'rare', price: 700, desc: 'Ropes down from a hovering gunship.', swatch: ['#353b3e', '#a4452c'] },
    { id: 'cannon', name: 'Human Cannonball', rarity: 'rare', price: 750, desc: 'Fired in on a long arc and lands with a roll.', swatch: ['#2a2e31', '#ff7a2a'] },
    { id: 'breach', name: 'Sea Breach', rarity: 'epic', price: 1300, desc: 'Erupts from the water in a plume of spray.', swatch: ['#1f8d98', '#eef8f1'] },
    { id: 'jetpack', name: 'Jetpack', rarity: 'epic', price: 1400, desc: 'Descends on twin thrusters and a heat shimmer.', swatch: ['#5a6266', '#ff9a3a'] },
    { id: 'whirlpool', name: 'Whirlpool', rarity: 'epic', price: 1450, desc: 'Rises from the centre of a spinning whirlpool.', swatch: ['#1a5a6a', '#a8f0ff'] },
    { id: 'orbital', name: 'Orbital Beacon', rarity: 'legendary', price: 2400, desc: 'Beamed down from orbit in a pillar of light.', swatch: ['#f4f0ff', '#8a7bff'] },
    { id: 'gulls', name: 'Gull Flock', rarity: 'legendary', price: 2200, desc: 'A spiral of gulls scatters to reveal them.', swatch: ['#f3efe4', '#3a3f42'] },
    { id: 'meteor', name: 'Meteor Strike', rarity: 'legendary', price: 2600, desc: 'Plummets in a burning shell and cracks the ground.', swatch: ['#ff6a1a', '#2a1a14', '#ffd04a'] },
  ],
  emotes: [
    { id: 'default', name: 'Salute', rarity: 'common', price: 0, desc: 'A crisp salute to the fallen.', swatch: ['#c9d2d0', '#6f7a7a'] },
    { id: 'fistpump', name: 'Fist Pump', rarity: 'common', price: 150, desc: 'Yes! Yes! YES!', swatch: ['#ffb000', '#3a3f42'] },
    { id: 'wave', name: 'Wave Off', rarity: 'common', price: 150, desc: 'A big friendly wave goodbye.', swatch: ['#9fd8ff', '#3a3f42'] },
    { id: 'pushups', name: 'Push-Ups', rarity: 'common', price: 250, desc: 'Drops and gives you ten.', swatch: ['#a7a07a', '#3a3f42'] },
    { id: 'flex', name: 'Flex', rarity: 'rare', price: 450, desc: 'Double-biceps pose. Hold it. Hold it.', swatch: ['#ff8a5a', '#3a3f42'] },
    { id: 'twirl', name: 'Gun Spin', rarity: 'rare', price: 550, desc: 'Spins the weapon and catches it clean.', swatch: ['#c8ccd0', '#2a2e31'] },
    { id: 'chest', name: 'Chest Pound', rarity: 'rare', price: 600, desc: 'Two pounds on the plate carrier and a roar.', swatch: ['#a4512c', '#3a3f42'] },
    { id: 'dance', name: 'Tide Shuffle', rarity: 'epic', price: 1100, desc: 'A smooth side-to-side shuffle.', swatch: ['#ff5ad0', '#5a8aff'] },
    { id: 'airguitar', name: 'Air Guitar', rarity: 'epic', price: 1200, desc: 'Shreds an invisible solo, knee slide included.', swatch: ['#c04dff', '#ffd04a'] },
    { id: 'lounge', name: 'Beach Day', rarity: 'epic', price: 1300, desc: 'Sets up a deck chair and kicks back.', swatch: ['#ffd88a', '#2e7d7a'] },
    { id: 'flag', name: 'Plant the Flag', rarity: 'legendary', price: 2200, desc: 'Plants your squad\'s banner in the island.', swatch: ['#ffb000', '#e0d4b6'] },
    { id: 'fireworks', name: 'Flare Salute', rarity: 'legendary', price: 2300, desc: 'Fires flares into the sky that burst in your squad colour.', swatch: ['#ff4a6a', '#ffd04a'] },
    { id: 'meditate', name: 'Eye of the Storm', rarity: 'legendary', price: 2500, desc: 'Levitates cross-legged inside a ring of swirling water.', swatch: ['#a8f0ff', '#2a5a7a'] },
  ],
  charms: [
    { id: 'default', name: 'None', rarity: 'common', price: 0, desc: 'Nothing dangling. All business.', swatch: ['#c9d2d0', '#6f7a7a'] },
    { id: 'tags', name: 'Dog Tags', rarity: 'common', price: 150, desc: 'Twin stamped tags on a bead chain.', swatch: ['#c8ccd0', '#5a6266'] },
    { id: 'dice', name: 'Lucky Dice', rarity: 'common', price: 150, desc: 'Fuzzy-free, red, and always rolling sixes.', swatch: ['#e83a3a', '#ffffff'] },
    { id: 'shell', name: 'Cowrie Shell', rarity: 'common', price: 200, desc: 'A spotted shell from the Kelp Shallows.', swatch: ['#f2e2c8', '#a0603a'] },
    { id: 'tooth', name: 'Shark Tooth', rarity: 'common', price: 250, desc: 'Big, serrated, and very real.', swatch: ['#f4f0e4', '#2a2e31'] },
    { id: 'duck', name: 'Rubber Duck', rarity: 'rare', price: 450, desc: 'Squeaks on reload. Probably.', swatch: ['#ffd23a', '#ff8a2a'] },
    { id: 'buoy', name: 'Mini Buoy', rarity: 'rare', price: 450, desc: 'Red-and-white floatie. Never sinks.', swatch: ['#e83a3a', '#f4f0e4'] },
    { id: 'compass', name: 'Brass Compass', rarity: 'rare', price: 550, desc: 'Points to the safe zone. Allegedly.', swatch: ['#c8a050', '#1c2a4a'] },
    { id: 'anchor', name: 'Tiny Anchor', rarity: 'rare', price: 550, desc: 'Cast iron, ship-shape.', swatch: ['#3a4246', '#c8b070'] },
    { id: 'crab', name: 'Hermit Crab', rarity: 'epic', price: 1000, desc: 'Lives in your weapon now. Pays no rent.', swatch: ['#ff6a3a', '#f2e2c8'] },
    { id: 'fish', name: 'Pufferfish', rarity: 'epic', price: 1100, desc: 'Puffs up when you take fire.', swatch: ['#ffd88a', '#6a8a3a'] },
    { id: 'lantern', name: 'Storm Lantern', rarity: 'epic', price: 1200, desc: 'A tiny glowing lantern for long nights.', swatch: ['#ffcf6a', '#3a2a1a'] },
    { id: 'coin', name: 'Salvage Coin', rarity: 'epic', price: 1200, desc: 'The first coin of the new world, drilled and hung.', swatch: ['#ffd24a', '#9a6a12'] },
    { id: 'gem', name: 'Prism Gem', rarity: 'legendary', price: 2000, desc: 'A spinning crystal that throws rainbow light.', swatch: ['#ff7ad9', '#7aa8ff', '#9dffb0'] },
    { id: 'kraken', name: 'Baby Kraken', rarity: 'legendary', price: 2200, desc: 'Wiggles its little tentacles at your enemies.', swatch: ['#6a3f9a', '#ff7ad9'] },
  ],
  tracers: [
    { id: 'default', name: 'Squad Standard', rarity: 'common', price: 0, desc: 'Tracers in your squad colour.', swatch: ['#ffb000', '#ffffff'] },
    { id: 'ember', name: 'Hot Lead', rarity: 'common', price: 250, desc: 'White-hot cores that shed sparks.', swatch: ['#fff2c8', '#ff7a2a'] },
    { id: 'emerald', name: 'Emerald', rarity: 'rare', price: 500, desc: 'Green cores with a fine glitter trail.', swatch: ['#6aff9a', '#1a5a3a'] },
    { id: 'violet', name: 'Ultraviolet', rarity: 'rare', price: 550, desc: 'Deep violet cores that hum.', swatch: ['#b46aff', '#2a1450'] },
    { id: 'ice', name: 'Cryo', rarity: 'rare', price: 600, desc: 'Ice-blue cores with frost motes.', swatch: ['#dff4ff', '#5aa8ff'] },
    { id: 'crimson', name: 'Crimson', rarity: 'epic', price: 1100, desc: 'Blood-red cores with a smoke wake.', swatch: ['#ff3a3a', '#3a0a0a'] },
    { id: 'gold', name: 'Gold Rush', rarity: 'epic', price: 1300, desc: 'Molten gold cores that rain glitter.', swatch: ['#ffd24a', '#9a6a12'] },
    { id: 'tide', name: 'Riptide', rarity: 'epic', price: 1400, desc: 'A water helix spirals around every round.', swatch: ['#6ae0ff', '#1a5a7a'] },
    { id: 'plasma', name: 'Arc Plasma', rarity: 'legendary', price: 2200, desc: 'Crackling electric arcs follow the round.', swatch: ['#e8f0ff', '#8a9cff'] },
    { id: 'prism', name: 'Prism', rarity: 'legendary', price: 2400, desc: 'Rainbow cores that cycle through the spectrum.', swatch: ['#ff7ad9', '#7aa8ff', '#9dffb0'] },
  ],
  // streak: which killstreak model the skin applies to ('all' = every streak vehicle).
  streakSkins: [
    { id: 'default', name: 'Navy Grey', rarity: 'common', price: 0, streak: 'all', desc: 'Standard-issue grey airframes.', swatch: ['#5a6266', '#a4452c'] },
    { id: 'desert', name: 'Sand Wing', rarity: 'common', price: 300, streak: 'all', desc: 'Desert tan airframes with brown bands.', swatch: ['#c8a873', '#6a4a2a'] },
    { id: 'shark', name: 'Sharkmouth', rarity: 'rare', price: 700, streak: 'all', desc: 'Grey airframes with painted shark teeth.', swatch: ['#6d7880', '#e83a3a', '#f4f0e4'] },
    { id: 'gullseye', name: 'Gull\'s Eye', rarity: 'rare', price: 800, streak: 'uav', desc: 'A white-and-grey UAV that looks like a gull.', swatch: ['#f3efe4', '#3a3f42'] },
    { id: 'totem', name: 'Tiki Totem', rarity: 'epic', price: 1200, streak: 'sentry', desc: 'Your sentry, carved as a grinning tiki totem.', swatch: ['#8d6a42', '#2ad0c0', '#ff6a3a'] },
    { id: 'stingray', name: 'Stingray', rarity: 'epic', price: 1400, streak: 'airstrike', desc: 'Black jets with manta-wing markings and blue burners.', swatch: ['#16191b', '#5aa8ff'] },
    { id: 'goldrush', name: 'Gold Rush', rarity: 'epic', price: 1500, streak: 'care', desc: 'A gold-plated care package with a sparkle trail.', swatch: ['#ffd24a', '#1c1a17'] },
    { id: 'leviathan', name: 'Leviathan', rarity: 'legendary', price: 2600, streak: 'gunship', desc: 'A sea-monster gunship: scaled hull, glowing eyes, abyssal tracers.', swatch: ['#0b1a2e', '#2ad0c0', '#ff4a3a'] },
    { id: 'synth', name: 'Neon Fleet', rarity: 'legendary', price: 2500, streak: 'all', desc: 'Every streak vehicle in black with violet neon edges.', swatch: ['#1a1430', '#c04dff', '#ff4fa8'] },
  ],
};

// Weapon camos: earned per weapon through challenges (not sold). tier:
// 'standard' (22: 9 SIM-1 challenge camos, set 'challenge', + 13 'bonus'), then
// 'gold' (all challenge camos on a weapon), 'diamond' (gold on 5 weapons),
// 'tidal' (all diamond, animated). `req` mirrors / suggests the per-weapon
// challenge; UI owns the tracking. Every id renders via gfx/camos.js.
export const CAMOS = [
  { id: 'none', name: 'Factory', tier: 'none', desc: 'Bare factory finish.', swatch: ['#3a4044', '#6a7278'] },
  // SIM-1's challenge camos (src/sim/weapons.js CAMO_CHALLENGES): the Gold track.
  { id: 'kelpweave', name: 'Kelpweave', tier: 'standard', set: 'challenge', req: { stat: 'kills', n: 10 }, desc: '10 kills', swatch: ['#3a6a3a', '#1a301a', '#9ab86a'] },
  { id: 'driftwood', name: 'Driftwood', tier: 'standard', set: 'challenge', req: { stat: 'kills', n: 25 }, desc: '25 kills', swatch: ['#9a7a58', '#5a4430'] },
  { id: 'saltcrust', name: 'Saltcrust', tier: 'standard', set: 'challenge', req: { stat: 'headshots', n: 10 }, desc: '10 headshots', swatch: ['#d8e0dc', '#6a7a80'] },
  { id: 'reefstripe', name: 'Reef Stripe', tier: 'standard', set: 'challenge', req: { stat: 'flanks', n: 5 }, desc: '5 flanking kills', swatch: ['#2f8f8a', '#f08a7e'] },
  { id: 'stormglass', name: 'Stormglass', tier: 'standard', set: 'challenge', req: { stat: 'longshots', n: 5 }, desc: '5 longshot kills', swatch: ['#5a6a80', '#2a3444', '#a8b8d0'] },
  { id: 'rustbloom', name: 'Rustbloom', tier: 'standard', set: 'challenge', req: { stat: 'closes', n: 5 }, desc: '5 kills within 3 tiles', swatch: ['#a4512c', '#5c3220'] },
  { id: 'nightoil', name: 'Night Oil', tier: 'standard', set: 'challenge', req: { stat: 'multis', n: 3 }, desc: '3 multi-kill turns', swatch: ['#0e0c12', '#7a4dff', '#2ad0c0'] },
  { id: 'harborgray', name: 'Harbor Gray', tier: 'standard', set: 'challenge', req: { stat: 'kills', n: 50 }, desc: '50 kills', swatch: ['#7a8890', '#3a4650'] },
  { id: 'tidemark', name: 'Tidemark', tier: 'standard', set: 'challenge', req: { stat: 'wins', n: 3 }, desc: 'Win 3 matches', swatch: ['#2a5a6a', '#e8dcc0'] },
  // Bonus standard camos (set 'bonus'): suggested extra challenges; UI may also grant them at weapon levels 17-20.
  { id: 'woodland', name: 'Woodland', tier: 'standard', set: 'bonus', req: { stat: 'kills', n: 10 }, desc: '10 kills', swatch: ['#4a5a32', '#2a2a1a', '#7a6a42'] },
  { id: 'desert', name: 'Dune', tier: 'standard', set: 'bonus', req: { stat: 'kills', n: 25 }, desc: '25 kills', swatch: ['#c8a873', '#8a6d44'] },
  { id: 'urban', name: 'Concrete', tier: 'standard', set: 'bonus', req: { stat: 'kills', n: 50 }, desc: '50 kills', swatch: ['#8f969a', '#3e4448'] },
  { id: 'kelp', name: 'Kelp Bed', tier: 'standard', set: 'bonus', req: { stat: 'flankKills', n: 5 }, desc: '5 flanking kills', swatch: ['#2d5a33', '#86a35c'] },
  { id: 'digital', name: 'Pixel Surf', tier: 'standard', set: 'bonus', req: { stat: 'flankKills', n: 15 }, desc: '15 flanking kills', swatch: ['#5a7a8a', '#2a3a4a', '#a8c0c8'] },
  { id: 'tiger', name: 'Tiger', tier: 'standard', set: 'bonus', req: { stat: 'longshots', n: 5 }, desc: '5 longshot kills (8+ tiles)', swatch: ['#e0a040', '#1a1a1a'] },
  { id: 'splinter', name: 'Splinter', tier: 'standard', set: 'bonus', req: { stat: 'longshots', n: 15 }, desc: '15 longshot kills', swatch: ['#7a8a6a', '#3a4a3a', '#b0b89a'] },
  { id: 'arctic', name: 'Floe', tier: 'standard', set: 'bonus', req: { stat: 'hardKills', n: 10 }, desc: '10 kills on shots under 50% chance', swatch: ['#e6ebee', '#8c99a3'] },
  { id: 'reef', name: 'Reef', tier: 'standard', set: 'bonus', req: { stat: 'coverKills', n: 10 }, desc: '10 kills on targets in cover', swatch: ['#f08a7e', '#2f8f8a'] },
  { id: 'dazzle', name: 'Dazzle', tier: 'standard', set: 'bonus', req: { stat: 'doubleKills', n: 3 }, desc: '3 double kills', swatch: ['#f2f2ee', '#1b1d22'] },
  { id: 'hex', name: 'Hexcore', tier: 'standard', set: 'bonus', req: { stat: 'wins', n: 3 }, desc: '3 wins with it equipped', swatch: ['#2c3034', '#5d666c'] },
  { id: 'topo', name: 'Bathymetry', tier: 'standard', set: 'bonus', req: { stat: 'top5', n: 10 }, desc: '10 top-5 finishes', swatch: ['#2a4a5a', '#7ac0c8'] },
  { id: 'magma', name: 'Magma', tier: 'standard', set: 'bonus', req: { stat: 'kills', n: 100 }, desc: '100 kills', swatch: ['#1a1412', '#ff6a1a'] },
  { id: 'gold', name: 'Gold', tier: 'gold', desc: 'Unlock every standard camo on this weapon.', swatch: ['#ffe08a', '#b8862a'] },
  { id: 'diamond', name: 'Diamond', tier: 'diamond', desc: 'Unlock Gold on 5 weapons.', swatch: ['#f4fbff', '#9ad8ff', '#ff9ae0'] },
  { id: 'tidal', name: 'Tidal', tier: 'tidal', desc: 'Unlock Diamond on every weapon. Animated.', swatch: ['#0a3a5a', '#2ad0e0', '#e8fbff'] },
];

/** Bundles: several items at a discount. price ≈ 70% of the parts. items: [{ slot, id }]. */
const BUNDLE_DEFS = [
  { id: 'b_starter', name: 'Deckhand Starter', rarity: 'rare', desc: 'Everything a fresh recruit needs to look the part.', items: [['skin', 'tidewater'], ['killFx', 'tidal'], ['dropIn', 'parachute'], ['charm', 'tags'], ['emote', 'wave']] },
  { id: 'b_harbor', name: 'Harbour Master', rarity: 'legendary', desc: 'Admiral Strand\'s full dress kit.', items: [['skin', 'op_admiral'], ['killFx', 'anchor'], ['emote', 'flag'], ['charm', 'compass'], ['dropIn', 'boat']] },
  { id: 'b_leviathan', name: 'Leviathan Rising', rarity: 'legendary', desc: 'The deep answers: monster gunship, ink and abyss.', items: [['skin', 'abyssal'], ['streakSkin', 'leviathan'], ['killFx', 'ink'], ['charm', 'kraken'], ['tracer', 'tide']] },
  { id: 'b_goldrush', name: 'Gold Rush', rarity: 'legendary', desc: 'Flaunt it. All of it.', items: [['skin', 'gilded'], ['killFx', 'coins'], ['tracer', 'gold'], ['charm', 'coin'], ['streakSkin', 'goldrush']] },
  { id: 'b_frost', name: 'Polar Relay', rarity: 'epic', desc: 'Hoarfrost\'s cold-weather operator set.', items: [['skin', 'op_frost'], ['killFx', 'shatter'], ['tracer', 'ice'], ['dropIn', 'whirlpool']] },
  { id: 'b_neon', name: 'Neon Nights', rarity: 'epic', desc: 'Synthwave kit, glitch kills and arc plasma.', items: [['skin', 'synthwave'], ['killFx', 'glitch'], ['tracer', 'violet'], ['charm', 'gem'], ['streakSkin', 'synth']] },
  { id: 'b_inferno', name: 'Rig Fire', rarity: 'legendary', desc: 'Cinder walked out of the fire. Now you can too.', items: [['skin', 'op_cinder'], ['killFx', 'ember'], ['dropIn', 'meteor'], ['tracer', 'ember'], ['charm', 'lantern']] },
  { id: 'b_reef', name: 'Reef Raider', rarity: 'epic', desc: 'Bright reef colours and a lot of sharks.', items: [['skin', 'coral'], ['killFx', 'sharks'], ['dropIn', 'jetski'], ['charm', 'crab'], ['emote', 'lounge']] },
];

export const DEFAULT_LOADOUT = { skin: 'default', killFx: 'default', dropIn: 'default', emote: 'default', charm: 'default', tracer: 'default', streakSkin: 'default' };

/** Slot key (singular, as in a loadout) → catalog list key. */
export const SLOTS = { skin: 'skins', killFx: 'killFx', dropIn: 'dropIns', emote: 'emotes', charm: 'charms', tracer: 'tracers', streakSkin: 'streakSkins' };
const SLOT_KEY = { ...SLOTS, skins: 'skins', dropIns: 'dropIns', emotes: 'emotes', charms: 'charms', tracers: 'tracers', streakSkins: 'streakSkins' };

/** Look up an item: slot is a loadout key ('skin', 'killFx', ...) or the plural catalog key. */
export function findCosmetic(slot, id) {
  if (slot === 'camo' || slot === 'camos') return CAMOS.find((c) => c.id === id) || null;
  const list = COSMETICS[SLOT_KEY[slot]];
  if (!list) return null;
  return list.find((c) => c.id === id) || null;
}

const roundTo = (v, s) => Math.round(v / s) * s;
export const BUNDLES = BUNDLE_DEFS.map((b) => {
  const items = b.items.map(([slot, id]) => ({ slot, id }));
  const full = items.reduce((s, it) => s + (findCosmetic(it.slot, it.id)?.price || 0), 0);
  return { id: b.id, name: b.name, rarity: b.rarity, desc: b.desc, items, fullPrice: full, price: roundTo(full * 0.7, 50) };
});

/** A loadout with every unknown id replaced by 'default'. Extra keys (e.g. camo) pass through. */
export function sanitizeLoadout(l) {
  const o = l || {};
  const out = {};
  for (const k of Object.keys(SLOTS)) out[k] = findCosmetic(k, o[k]) ? o[k] : 'default';
  if (o.camo !== undefined) out.camo = findCosmetic('camo', o.camo) ? o.camo : 'none';
  return out;
}

/**
 * Random loadout for a bot. `rnd` is a () => [0,1) function (Math.random by
 * default). Cheaper items are more common, and some bots stay on defaults.
 * (The first three draws match 3.0 so old seeds keep their looks.)
 */
export function randomLoadout(rnd = Math.random) {
  const pick = (list) => {
    if (rnd() < 0.3) return 'default';
    const w = list.map((c) => (c.id === 'default' ? 0 : 1 / (1 + RARITY[c.rarity].order * 0.9)));
    let r = rnd() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < list.length; i++) { if ((r -= w[i]) < 0) return list[i].id; }
    return 'default';
  };
  const C = COSMETICS;
  const out = { skin: pick(C.skins), killFx: pick(C.killFx), dropIn: pick(C.dropIns) };
  out.emote = pick(C.emotes); out.charm = pick(C.charms); out.tracer = pick(C.tracers); out.streakSkin = pick(C.streakSkins);
  const camos = CAMOS.filter((c) => c.tier === 'standard');
  const r = rnd();
  out.camo = r < 0.45 ? 'none' : r < 0.93 ? camos[(rnd() * camos.length) | 0].id : r < 0.97 ? 'gold' : r < 0.99 ? 'diamond' : 'tidal';
  return out;
}

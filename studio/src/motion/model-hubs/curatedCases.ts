import type { HubShowcaseCase } from '../modelHubs';
import type { StudioDestination } from '../creativeStudios';
import gptHeroHd from './gpt-image-2-6/hero.webp';
import glassSculptureHd from '../scene-art/studio-glass-sculpture.avif';
import lightShadowProductHd from './gpt-image-2-6/light-shadow-product.avif';
import retroPrintPosterHd from './gpt-image-2-6/retro-print-poster.avif';
import surreal3dPosterHd from './gpt-image-2-6/surreal-3d-poster.avif';

declare const __STUDIO_PREVIEW_BASE__: string;
declare const __MODEL_HUB_PREVIEW_HASHES__: Record<string, string>;

const hubPreviewUrl = (name: string) => {
  const hash = __MODEL_HUB_PREVIEW_HASHES__[name];
  return hash ? __STUDIO_PREVIEW_BASE__ + hash + name.slice(name.lastIndexOf('.')) : '';
};

const TV = ['Cinema & VFX', 'Creative Ads', 'Motion & Speed', 'Fashion & Visual'] as const;
const TI = ['Poster & KV', 'Fashion & Portrait', 'Product & 3D'] as const;
const srcUrl = (author: string, spec: string) =>
  !spec ? undefined : (/^\d+$/.test(spec) ? `https://x.com/${author.replace(/^@/, '')}/status/${spec}` : spec);

type VRow = readonly [number, string, number, string, string, number, string];
type IRow = readonly [number, string, number, string | null, string, string, number, string];

const V: readonly VRow[] = [
  [1,"4K Hyperspace Neon Ring Tunnel",0,"","",2.326,"A lone technician sprints across the curved outer shell of a colossal floating engine-world as vast pink-and-blue energy conduits pulse with hyperspace light, anamorphic 4K cinema."],
  [2,"Sunset Palm Formula 1 Racing Cinema",2,"","",2.326,"Sunset Palm Formula 1 Racing Cinema, cinematic 4K motion, dramatic lighting"],
  [3,"4K Forest Blue Morpho Butterfly Flight",0,"","",16/9,"Photorealistic single continuous unbroken FPV tracking shot gliding behind an iridescent blue morpho butterfly weaving through sunlit emerald forest mist, 4K macro cinema."],
  [4,"4K Interstellar Planetary Rings Horizon",0,"","",16/9,"Breathtaking orbital view above a vast ringed gas-giant planet glowing with swirling amber and teal storm bands as shimmering icy rings sweep across the starlit horizon, 4K cinema."],
  [5,"Monaco Harbor F1 Grid Aerial Film",2,"","",16/9,"Vintage motorsport aerial film sweeping over Monaco harbor and a sunlit Formula 1 starting grid, cutting from classic open-face helmets and racing goggles to roaring coastal turns, 35mm cinema."],
  [6,"4K Sunrise Reeds Sci-Fi Skimmer",0,"","",16/9,"Single continuous unbroken 35mm tracking shot skimming low over golden sunrise marsh reeds behind a sleek sci-fi hover skimmer kicking up luminous water spray, 4K photorealistic cinema."],
  [7,"4K Cyan Ice Dragon Cloud Battle",0,"","",16/9,"Single continuous FPV cinematic oner chasing a colossal cyan ice dragon bursting through storm clouds in an aerial fantasy battle, crackling frost lightning and anamorphic 4K detail."],
  [8,"Glowing Snow-Spray Extreme Snowboarding",2,"","",16/9,"Glowing Snow-Spray Extreme Snowboarding, cinematic 4K motion, dramatic lighting"],
  [9,"Paris Eiffel Twilight Skyline Cinema",0,"","",16/9,"Paris Eiffel Twilight Skyline Cinema, cinematic 4K motion, dramatic lighting"],
  [10,"4K Fiery Speedforce Energy Vortex",2,"","",16/9,"Photorealistic 4K anamorphic action shot of a sprinting figure engulfed in a blazing golden speedforce lightning vortex tearing through a dark twilight street, swirling embers and lens flare."],
  [11,"Obsidian Shards Explosion Minimal VFX",0,"","",16/9,"Obsidian Shards Explosion Minimal VFX, cinematic 4K motion, dramatic lighting"],
  [12,"Dark Light-Trail Runner Minimal VFX",0,"","",16/9,"Dark Light-Trail Runner Minimal VFX, cinematic 4K motion, dramatic lighting"],
  [13,"4K Tectonic Earth Cracking VFX Shot",0,"","",2.326,"Multi-shot Hollywood disaster epic on 35mm film: massive tectonic fault lines ripping open across a rocky valley with erupting dust plumes, sweeping aerial and ground-level action angles."],
  [14,"4K Night Rainstorm Dramatic Cinema",0,"","",16/9,"Moody 4K night rainstorm cinema shot: a young woman with long rain-soaked hair stands beneath flickering neon streetlights as torrential downpour streaks through cool cyan fog, 35mm film grain."],
  [15,"4K Arctic Glacier High-Speed POV",2,"","",2.326,"single continuous shot, one take no cuts, cinematic FPV oner, 4K ultra-detailed, photorealistic macro detail, anamorphic film look — 4K Arctic Glacier High-Speed POV."],
  [16,"Retro American Diner Cinema Shot",0,"","",16/9,"Retro American diner interior on 35mm film: warm tungsten booth lights, checkered floor, chrome counter reflections, slow cinematic tracking shot with nostalgic film grain."],
  [17,"Monochrome Twin Symmetry Couture",3,"","",4/3,"High-contrast monochrome editorial fashion film: twin avant-garde models in sculptural black-and-white couture standing in razor-sharp mirror symmetry beneath stark architectural spotlights."],
  [18,"Crimson Shades Editorial Fashion Film",3,"","",16/9,"Crimson Shades Editorial Fashion Film, cinematic 4K motion, dramatic lighting"],
  [19,"Paris Seine Bridge Blue-Hour Film",0,"","",4/3,"Paris Seine Bridge Blue-Hour Film, cinematic 4K motion, dramatic lighting"],
  [20,"Neon Convertible Night Drive Cinema",0,"","",16/9,"Neon Convertible Night Drive Cinema, cinematic 4K motion, dramatic lighting"],
  [21,"Massive Festival Stage Crowd Epic",3,"","",4/3,"Massive Festival Stage Crowd Epic, cinematic 4K motion, dramatic lighting"],
  [22,"Bridge Twin Supercar Drift",2,"@PromptSin","2111042013210825211",16/9,"High-speed automotive action tracking shot across a sunlit suspension bridge: a gleaming crimson coupe and matte-black sports car drifting inches apart through swirling tire smoke."],
  [23,"Cloud Sea Celestial Palace",0,"@ClaraOnAI","2115753803375141156",16/9,"Majestic wide establishing shot of an ancient Chinese celestial palace perched above an endless sea of golden sunlit clouds as a lone robed figure gazes from a carved stone terrace."],
  [24,"Celestial Marble Sky-Bridge",0,"@Soranlan","2117463209225703771",16/9,"Sweeping sunlit wuxia cinema shot gliding behind three white-and-teal robed travelers crossing a carved white marble sky-bridge."],
  [25,"Venice Folding Into a Sphere",0,"@Just_sharon7","2100541954685895043",16/9,"Surreal Inception-style fantasy cinema shot: a pink-haired courier sprints along a Venetian canal pier as the entire historic city curves and folds upward into a floating sphere."],
  [26,"Iridescent Baby Dragon Hatchling",0,"@Adnan_Ai2","2113451899013996748",16/9,"Photorealistic fantasy macro close-up on a rustic stone hearth: a tiny pearlescent pink-and-ivory baby dragon with delicate iridescent scales unfurls its wings beside warm embers."],
  [27,"Futuristic Subway Hyper-Speed",2,"@liluocheng13","2119302185263743113",16/9,"High-velocity cyberpunk action shot streaking through a neon-lit underground subway car as a crimson-cloaked fighter charges down the pulsing aisle at hyper-speed."],
  [28,"Istanbul Cloud-Sea Sunrise Aerial",2,"@Naiknelofar788","2106439652278411435",16/9,"Breathtaking aerial drone glide sweeping past an ornate historic mosque dome and slender minaret rising majestically above a golden cloud sea at Istanbul sunrise."],
  [29,"Misty Waterfall Sky-Bridge",2,"@antibokeh_","2122009890436636795",16/9,"Sweeping fantasy vista pushing gently forward from an ornate stone balcony overlooking a colossal arched viaduct spanning mist-veiled waterfalls and emerald cliffs."],
  [30,"Coastal Highway Superbike Lean",2,"@itsSaira_1","2104064261005709551",16/9,"Adrenaline-charged tracking shot low alongside a matte-black futuristic superbike leaning sharply into a sweeping coastal highway bend."],
  [31,"Swordsman vs Shadow Horde",1,"@itsSaira_1","2099006619988459985",16/9,"Epic dark-fantasy widescreen battle sequence on a misty highland battlefield: a black-robed swordsman swings a blazing blade through a surging horde of shadow warriors."],
  [32,"Samurai vs Smoke Serpent",0,"@Viniai_","2122916879824306422",16/9,"Dramatic backlit widescreen dark-fantasy cinema shot over churning shallow ocean surf near a ruined pagoda as a lone silhouette samurai confronts a towering serpent of black smoke."],
  [33,"Alien Bazaar Sci-Fi Long Take",0,"@Alin_Reaper05","2116029596868972882",16/9,"Immersive sci-fi worldbuilding tracking shot walking smoothly behind armored travelers through a bustling alien marketplace beneath towering neon-lit sandstone arches."],
  [34,"Future Plaza Sci-Fi Monster Truck",2,"@Zyrellix","2107707535147081829",16/9,"Photorealistic daytime sci-fi spectacle outside white curved futuristic architecture as a massive neon-grilled off-road combat truck rumbles across the sunlit plaza."],
  [35,"4K Cloudbreak Sunrise Cliff Aerial",0,"","",16/9,"single continuous shot, one take no cuts, cinematic oner, cinematic lighting, photorealistic, 35mm film quality, professional color — 4K Cloudbreak Sunrise Cliff Aerial."],
  [36,"Golden Tunnel Red-White Supercar Speed",2,"","",9/16,"Golden Tunnel Red-White Supercar Speed, cinematic 4K motion, dramatic lighting"],
  [37,"Orange Supercar Cockpit Speed Cinema",2,"","",16/9,"Orange Supercar Cockpit Speed Cinema, cinematic 4K motion, dramatic lighting"],
  [38,"4K Apocalyptic Explosion Cyber Rider",0,"","",2.326,"Gritty handheld 4K anamorphic tracking shot racing alongside a cybernetic motorcycle rider tearing across scorched wasteland dunes ahead of a towering fiery shockwave explosion."],
  [39,"Subterranean Glowing Diamond Vein VFX",0,"","",4/3,"Subterranean Glowing Diamond Vein VFX, cinematic 4K motion, dramatic lighting"],
  [40,"Coastal Highway Supercar Chase Film",2,"","",16/9,"Coastal Highway Supercar Chase Film, cinematic 4K motion, dramatic lighting"],
  [41,"4K Giant Spider Mech Military Sci-Fi",0,"","",16/9,"Photorealistic anamorphic war-film sci-fi shot in harsh desert sunlight: a colossal weathered military spider mech strides through billowing dust clouds while armored troops advance below."],
  [42,"Midnight Gas Station Crimson Supercar",2,"","",16/9,"Midnight Gas Station Crimson Supercar, cinematic 4K motion, dramatic lighting"],
  [43,"4K Waterfall Cyber Dirtbike Chase",2,"","",2.326,"High-speed 4K anamorphic action chase along a mist-drenched crystal canyon waterfall: cybernetic dirtbike riders leap over churning rapids beneath the ruined hull of a stranded starship."],
  [44,"4K Deep-Sea Sci-Fi Astronaut Visor",0,"","",16/9,"An original deep-sea sci-fi world: an astronaut's helmet visor reflects a sunless ocean trench lit by vast colonies of glowing bio-mechanical coral pulsing like neon circuitry."],
  [45,"Cyber Light-Beam Glasses Close-Up",0,"","",16/9,"Cyber Light-Beam Glasses Close-Up, cinematic 4K motion, dramatic lighting"],
  [46,"4K Dragon Soaring Over Glacial Peak",0,"","",2.326,"Single continuous unbroken aerial tracking shot soaring alongside a massive winged dragon banking over jagged snow-covered glacial peaks in crisp golden mountain light, 4K cinema."],
  [47,"Cyber Warehouse High-Energy Dance Stage",3,"","",16/9,"Cyber Warehouse High-Energy Dance Stage, cinematic 4K motion, dramatic lighting"],
  [48,"4K Cockpit Glowing Alien Mushroom Forest",0,"","",2.326,"First-person cockpit POV with naturalistic head movement gliding through a twilight alien forest of towering bioluminescent mushrooms glowing teal and violet across misty canopy trails."],
  [49,"4K Black-Sand Samurai vs Ancient Giant",0,"","",2.326,"Naturalistic anamorphic master shot on a windswept volcanic black-sand beach: a lone armored samurai raises a gleaming katana before an ancient stone giant emerging from coastal fog."],
  [50,"Minimalist White Corridor Martial Arts",0,"","",16/9,"Cinematic wide tracking shot of two martial artists sparring in a stark minimalist white corridor, crisp choreography, clean architectural shadows and fluid slow-motion impact."],
  [51,"4K Golden Fantasy Balloon Rollercoaster",0,"","",2.326,"single continuous shot, one take no cuts, cinematic FPV oner, 4K ultra-detailed, photorealistic macro detail, anamorphic film look — 4K Golden Fantasy Balloon Rollercoaster."],
  [52,"4K Aircraft Carrier Cinematic Ocean Cruise",0,"","",16/9,"Photorealistic naval documentary aerial sweeping across a colossal aircraft carrier slicing through dark rolling ocean swells beneath diffused overcast daylight and swirling sea spray."],
  [53,"4K Industrial Port Epic Crowd Aerial",0,"","",16/9,"Sweeping wide shot of a vast crowd flooding across a sprawling harbor dock toward waiting ships as massive cranes loom overhead."],
  [54,"4K Amethyst & Ice Crystal Macro Clash",0,"","",16/9,"Macro fantasy vista inside a vast canyon of towering translucent amethyst and ice crystals refracting a twin-sun sky into shimmering prismatic shards across a crystalline basin."],
  [55,"4K Glowing Filament Macro Energy Flow",0,"","",16/9,"Extreme macro tracking shot along cybernetic micro-circuitry threading into synthetic muscle as golden fiber-optic filaments surge with luminous energy pulses beneath translucent skin."],
  [56,"4K Pixar-Grade Fuzzy Monster Adventure",1,"","",16/9,"Multi-shot 3D animated adventure film in vibrant Pixar-grade CGI: a wide-eyed fuzzy teal monster bounds through a sunlit whimsical forest with playful dynamic camera angles and plush fur detail."],
  [57,"4K Sunlit Enchanted Mushroom Forest",0,"","",16/9,"Single continuous FPV macro oner weaving through a sunlit enchanted forest of giant dew-covered mushrooms, floating golden pollen motes and lush moss in anamorphic 4K lighting."],
  [58,"4K Astronaut Visor Fire Reflection",0,"","",2.326,"Intimate anamorphic close-up on a weathered astronaut's reflective helmet visor as roaring golden launch flames and swirling sparks dance across the curved glass in dramatic 4K realism."],
  [59,"4K Dust Storm Alien Planet Vista",0,"","",2.326,"Anamorphic 2.39:1 sci-fi vista across an arid alien desert planet as towering ochre dust storms sweep past monolithic rock spires under hazy twin-sun golden-hour light, 4K film grain."],
  [60,"4K Fantasy Horde Epic Plains Charge",0,"","",16/9,"Epic wide fantasy battle aerial over windswept highland plains: a young warrior heroine and silver-armored knight lead a vanguard charge into a thundering horde of towering ogres beneath storm clouds."],
  [61,"4K Bioluminescent Mushroom Jungle Rover",2,"","",2.326,"Naturalistic anamorphic tracking shot following an armored sci-fi exploration rover rolling through a misty night jungle illuminated by giant cyan-and-violet bioluminescent mushrooms, 4K cinema."],
  [62,"4K Golden Rainforest Primates Documentary",0,"","",16/9,"Photorealistic anamorphic wildlife documentary shot in a lush misty rainforest: golden morning sunbeams shafting through emerald canopy onto wild primates moving gracefully among mossy branches."],
  [63,"4K Pure White Butterfly Slow-Mo",0,"","",16/9,"Ultra-slow-motion 4K anamorphic macro film of a pure white butterfly fluttering across soft pastel light with gossamer wing detail, creamy highlight roll-off and ethereal shallow depth of field."],
  [64,"Twilight Glacial Ridge Cinema Shot",0,"","",2.326,"Sweeping aerial cinema shot gliding over a jagged glacial snow ridge at blue-hour twilight, lone figure silhouetted against icy mist."],
  [65,"Orbital Fighter Split-Screen Sci-Fi",0,"","",16/9,"Low Earth orbit sci-fi dogfight in dynamic split-screen cinema framing: sleek interceptor fighters banking over glowing planetary horizons, dramatic volumetric sunlight and crisp 4K motion."],
  [66,"Monochrome High-Contrast Slam Dunk",2,"","",3/2,"High-contrast monochrome sports action shot of a basketball player soaring for an explosive mid-air slam dunk beneath dramatic stadium rim lighting and floating chalk dust."],
  [67,"Lilac Ethereal Fantasy Couture Portrait",3,"","",4/3,"Lilac Ethereal Fantasy Couture Portrait, cinematic 4K motion, dramatic lighting"],
  [68,"Golden Sunset Backlit Cinema Portrait",3,"","",0.9,"Golden Sunset Backlit Cinema Portrait, cinematic 4K motion, dramatic lighting"],
  [69,"Neon Street Walk Cinematic Tracking Shot",0,"","",16/9,"Cinematic tracking shot following a pink-haired protagonist walking through a rain-slicked neon night street, glowing shop signs reflecting on wet asphalt, anamorphic bokeh and 35mm film grain."],
  [70,"Neon Giant Frogs Concert Stage VFX",3,"","",9/16,"Neon Giant Frogs Concert Stage VFX, cinematic 4K motion, dramatic lighting"],
];

const I: readonly IRow[] = [
  [1,"Blazing Amber Cyber Goggles Silhouette",1,gptHeroHd,"","",16/9,"Dramatic editorial studio silhouette of a futuristic model in sleek black couture wearing blazing amber-lit cyber goggles against deep smoky shadow, sharp rim highlights, 8k photography."],
  [2,"Sunset Cliff Glowing Perfume Campaign",2,null,"","",4/3,"Luxury fragrance campaign key visual atop a windswept coastal cliff at golden sunset: a radiant sculptural glass perfume bottle catching warm backlit ocean glow, ultra-crisp 8k editorial photography."],
  [3,"Skyline Window Tailored Suit Couture",1,null,"","",4/3,"High-rise corner office framed by a panoramic city skyline window at dusk: fashion model in an oversized tailored grey blazer and shimmering gold skirt seated effortlessly in architectural light."],
  [4,"Moody Jazz Trumpet Cinema Frame",0,null,"","",3/2,"Intimate dimly lit jazz club with moody warm side-lighting: musician with eyes closed playing a gleaming brass trumpet, rich shadow falloff and authentic 35mm film grain."],
  [5,"Urban Neon Deer Surreal Vogue Editorial",1,null,"","",4/3,"Surreal high-fashion Vogue editorial on a rain-slicked neon city avenue at night: an avant-garde model in sculptural trench couture poised calmly beside a graceful luminous stag beneath glowing streetlamps."],
  [6,"Monochrome Eagle Soaring Mountain Peak",0,null,"","",16/9,"High-contrast black-and-white aerial wildlife photograph: a majestic eagle with wings spread wide soaring inches from the lens over jagged misty alpine peaks."],
  [7,"Iridescent Glass Sculpture",2,glassSculptureHd,"","",4/3,"Minimalist sculptural ribbon of blown dichroic glass floating in soft lavender-pearl studio light, delicate violet and cyan caustics, ultra-clean architectural product render, 8k octane clarity."],
  [8,"Crimson Darkroom Film Developing Still",0,null,"","",16/9,"Vintage analog photography darkroom illuminated solely by a glowing crimson safelight as a photographer delicately lifts a glistening silver-gelatin print from a developing tray."],
  [9,"Golden Ocean Sunset Helicopter Silhouette",0,null,"","",9/16,"Golden Ocean Sunset Helicopter Silhouette, high-budget cinematic visual, ultra-detailed editorial lighting, 8k"],
  [10,"Stormy Ocean Pirate Captain Naval Battle",0,null,"","",1.905,"Stormy high-seas naval battle key visual: weathered pirate captain at the helm amid towering waves, blazing galleon cannons in the background, dramatic lightning and cinematic rain spray."],
  [11,"Luminous Translucent Koi Macro Art",2,null,"","",1,"Luminous Translucent Koi Macro Art, ultra-detailed cinematic lighting, 8k high-aesthetic editorial artwork."],
  [12,"High-Fashion Dreamy Dusk Portrait",1,null,"","",9/16,"Photorealistic high-fashion full-body editorial portrait in a dark-toned dreamy hazy twilight atmosphere, dramatic rim lighting and 35mm film grain."],
  [13,"Candlelit Ghost Cowboy Poker Dark Fantasy",0,null,"","",3/2,"Dark-fantasy candlelit western saloon: spectral cowboy dealing a fateful poker hand across a scarred oak table, flickering amber candlelight, swirling smoke, rich chiaroscuro shadows."],
  [14,"Fiery Orbital Pillar Planet Impact",0,null,"","",2.295,"Fiery Orbital Pillar Planet Impact, ultra-detailed cinematic lighting, 8k high-aesthetic editorial artwork."],
  [15,"Crimson Velvet Corridor Kubrick Symmetry",0,null,"","",16/9,"Surreal one-point symmetrical crimson-velvet corridor inspired by Kubrick cinema, dramatic overhead theatrical lighting, glossy reflections, bold editorial color palette."],
  [16,"Needle-Felt Space Cat Rocket Stop-Motion",2,null,"","",16/9,"Handcrafted wool needle-felt stop-motion diorama: a space-helmeted cat piloting a colorful stitched rocket blasting fluffy orange-and-blue felt clouds across a deep navy starry sky."],
  [17,"Golden Rooftop Backlit Silhouette",0,null,"","",3/2,"Expansive concrete rooftop at golden sunset: dramatic backlit silhouette sprinting with a billowing coat casting long diagonal shadows across weathered concrete, warm 35mm cinema still."],
  [18,"Giant Mushroom Modular Synth Stage",0,null,"","",1,"Surreal dark studio installation: a towering giant white mushroom wired with colorful patch cables into glowing modular analog synthesizers bathed in moody theatrical haze."],
  [19,"Alien Spore Jungle Astronaut Expedition",0,null,"","",16/9,"Alien Spore Jungle Astronaut Expedition, ultra-detailed cinematic lighting, 8k high-aesthetic editorial artwork."],
  [20,"Starlit Colossal Tsunami Epic Army",0,null,"","",16/9,"Starlit Colossal Tsunami Epic Army, ultra-detailed cinematic lighting, 8k high-aesthetic editorial artwork."],
  [21,"Botanical Shadow Fragrance",2,lightShadowProductHd,"","",16/9,"Luxury amber glass dropper bottle resting on raw travertine stone plinth with crisp afternoon botanical leaf shadows cast across warm plaster wall, editorial stillness."],
  [22,"Two-Ink Risograph Poster",0,retroPrintPosterHd,"","",4/3,"Bold two-ink risograph graphic poster on textured uncoated paper stock, tall condensed display typography paired with halftone geometric illustration, tactile print grain."],
  [23,"Surreal 3D Art Direction",0,surreal3dPosterHd,"","",16/9,"Surreal minimalist 3D art direction key visual with sculptural glossy forms, dramatic studio rim light, rich atmospheric contrast, museum exhibition poster composition."],
  [24,"Gothic Cathedral Silver Armor Knight",0,null,"","",2/3,"Dimly lit gothic stone cathedral: a knight in sculpted polished silver plate armor standing in moody chiaroscuro shafts of stained-glass light, high-budget dark-fantasy film still."],
  [25,"Wong Kar-Wai Amber Neon Corridor",0,null,"","",9/16,"Warm amber-lit wooden hallway beneath glowing retro neon signage: stylish protagonist in a vivid ochre jacket bathed in atmospheric Wong Kar-Wai cinema color and rich 35mm film grain."],
  [26,"Neon Marquee Retro Cinema Still",0,null,"","",4/3,"Deep cobalt twilight outside a glowing vintage cinema marquee: protagonist in a shimmering gold blouse and crimson skirt framed in warm tungsten bokeh and nostalgic 35mm cinema tones."],
  [27,"Brutalist Concrete All-Black Couture",1,null,"","",2/3,"Brutalist concrete architecture at dusk, avant-garde all-black layered couture silhouette paired with a crisp sculptural white bag."],
  [28,"Torn-Paper Collage Avant-Garde Portrait",1,null,"","",4/3,"Avant-garde mixed-media editorial art: crisp photographic portrait torn in horizontal strips and layered with bold ink spiral textures."],
  [29,"Crimson Hallway Dramatic Film Portrait",1,null,"","",4/3,"Crimson Hallway Dramatic Film Portrait, cinematic dramatic lighting, ultra-detailed 8k high-aesthetic artwork."],
  [30,"Paris Monochrome Couture Runway",1,null,"","",3/2,"Paris Fashion Week monochrome runway under crisp overhead spotlights: a long line of models in tailored all-black coats striding down a dark glossy reflective catwalk."],
  [31,"Crimson Escalator Geometric Cinema",1,null,"","",3/4,"Symmetrical crimson-red metallic escalator framing a sharp figure in a black leather blazer and crisp white shirt, bold geometric perspective and graphic high-contrast editorial light."],
  [32,"Tangerine Venetian Blinds Light Study",0,null,"","",3/4,"Intense tangerine-red tungsten light slicing through Venetian blinds across a crisp collared shirt, bold chiaroscuro film color study."],
  [33,"Golden Hour 35mm Film Close-Up",0,null,"","",4/3,"Golden Hour 35mm Film Close-Up, cinematic dramatic lighting, ultra-detailed 8k high-aesthetic artwork."],
  [34,"Crimson Studio Boxing Editorial",1,null,"","",3/4,"Saturated crimson studio backdrop: fierce fashion editorial portrait with wind-swept hair and glossy red boxing gloves raised in frame, razor-sharp studio strobe lighting."],
  [35,"Minimalist White Dome Burgundy Gown",1,null,"","",3/4,"Minimalist futuristic white curved architectural dome: a solitary figure in a floor-length burgundy gown standing beneath sculptural soft diffused skylight, calm editorial poise."],
];


export function buildSeedanceShowcaseCases(destination: StudioDestination): HubShowcaseCase[] {
  return V.map(([n, title, t, author, s, aspectRatio, prompt]) => ({
    id: `sd-${n}`,
    title,
    tag: TV[t],
    poster: hubPreviewUrl(`hub-sd-${n}.webp`),
    video: hubPreviewUrl(`hub-sd-${n}.mp4`),
    author: author || undefined,
    sourceUrl: srcUrl(author, s),
    aspectRatio,
    prompt,
    destination,
  }));
}

export function buildGptImageShowcaseCases(destination: StudioDestination): HubShowcaseCase[] {
  return I.map(([n, title, t, bundledPoster, author, s, aspectRatio, prompt]) => ({
    id: `gi-${n}`,
    title,
    tag: TI[t],
    poster: bundledPoster ?? hubPreviewUrl(`hub-gi-${n}.webp`),
    author: author || undefined,
    sourceUrl: srcUrl(author, s),
    aspectRatio,
    prompt,
    destination,
  }));
}

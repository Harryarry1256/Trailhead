// Shared catalog — kept in sync with the PRODUCTS/RETAILERS arrays in
// index.html. This is what the background refresh job iterates over, and
// what the lookup endpoint uses as the canonical retailer list (it no
// longer trusts whatever the browser sends, for consistency + safety).

export const RETAILERS = [
  { name: "Evo Cycles", domain: "evocycles.co.nz" },
  { name: "99 Bikes", domain: "99bikes.co.nz" },
  { name: "Kiwivelo", domain: "kiwivelo.co.nz" },
  { name: "Hyper Ride", domain: "hyperride.co.nz" }
];

export const PRODUCTS = [
  // Mountain Bikes
  { name: "Talon 29 3", brand: "Giant", cat: "mtb" },
  { name: "Marlin 7", brand: "Trek", cat: "mtb" },
  { name: "Big Trail 400", brand: "Merida", cat: "mtb" },
  { name: "Xtrada 5", brand: "Polygon", cat: "mtb" },
  { name: "Fluid FS 3", brand: "Norco", cat: "mtb" },
  { name: "Chameleon", brand: "Santa Cruz", cat: "mtb" },
  { name: "Bobcat Trail 4", brand: "Marin", cat: "mtb" },
  { name: "Rockhopper Sport 29", brand: "Specialized", cat: "mtb" },
  // Road Bikes
  { name: "Domane AL 2", brand: "Trek", cat: "road" },
  { name: "Contend 3", brand: "Giant", cat: "road" },
  { name: "Scultura 400", brand: "Merida", cat: "road" },
  { name: "Strattos S5", brand: "Polygon", cat: "road" },
  { name: "Allez", brand: "Specialized", cat: "road" },
  { name: "Speedster 30", brand: "Scott", cat: "road" },
  // E-Bikes
  { name: "Explore E+ 3", brand: "Giant", cat: "ebike" },
  { name: "Verve+ 2", brand: "Trek", cat: "ebike" },
  { name: "Path E3", brand: "Polygon", cat: "ebike" },
  { name: "eSpresso City 400 EQ", brand: "Merida", cat: "ebike" },
  { name: "PL Carbon Pro", brand: "Amflow", cat: "ebike" },
  { name: "Turbo Vado 3.0", brand: "Specialized", cat: "ebike" },
  // Kids & BMX
  { name: "ARX 20", brand: "Giant", cat: "kids" },
  { name: "Downtown 20", brand: "Haro", cat: "kids" },
  { name: "Rampage 24", brand: "Norco", cat: "kids" },
  { name: "Precaliber 20", brand: "Trek", cat: "kids" },
  { name: "Premier 3", brand: "Polygon", cat: "kids" },
  // Helmets
  { name: "Ventral Air MIPS", brand: "POC", cat: "helmets" },
  { name: "Chakra Plus", brand: "Kali Protectives", cat: "helmets" },
  { name: "Fixture MIPS", brand: "Giro", cat: "helmets" },
  { name: "Align II", brand: "Specialized", cat: "helmets" },
  { name: "Falcon XR MIPS", brand: "Bell", cat: "helmets" },
  { name: "Compact", brand: "Lazer", cat: "helmets" },
  { name: "Echo", brand: "MET", cat: "helmets" },
  // Apparel
  { name: "Perfetto RoS Jacket", brand: "Castelli", cat: "apparel" },
  { name: "Free Aero RC Bib Shorts", brand: "Castelli", cat: "apparel" },
  { name: "Essential Road Jersey", brand: "POC", cat: "apparel" },
  { name: "Core Jersey", brand: "Rapha", cat: "apparel" },
  { name: "Zap Bib Knicks", brand: "Sugoi", cat: "apparel" },
  { name: "Gabba RoS Jersey", brand: "Castelli", cat: "apparel" },
  { name: "Ridecamp Gloves", brand: "100%", cat: "apparel" },
  // Parts & Components
  { name: "105 R7100 Groupset", brand: "Shimano", cat: "parts" },
  { name: "SPD-SL Pedals", brand: "Shimano", cat: "parts" },
  { name: "34 Float Performance Fork", brand: "Fox", cat: "parts" },
  { name: "Marathon Plus Tyre", brand: "Schwalbe", cat: "parts" },
  { name: "Grand Prix 5000 Tyre", brand: "Continental", cat: "parts" },
  { name: "Freewheel", brand: "White Industries", cat: "parts" },
  { name: "Deore M6100 Disc Brakes", brand: "Shimano", cat: "parts" },
  { name: "X11 Chain", brand: "KMC", cat: "parts" },
  // Accessories
  { name: "Edge 130 Plus", brand: "Garmin", cat: "accessories" },
  { name: "Blinder Light Set", brand: "Knog", cat: "accessories" },
  { name: "New York Chain Lock", brand: "Kryptonite", cat: "accessories" },
  { name: "ProRide Roof Rack", brand: "Thule", cat: "accessories" },
  { name: "Mandible Bottle Cage", brand: "Arundel", cat: "accessories" },
  { name: "Back-Roller Panniers", brand: "Ortlieb", cat: "accessories" },
  { name: "Joe Blow Track Pump", brand: "Topeak", cat: "accessories" },
  { name: "Shoe Covers", brand: "VeloToze", cat: "accessories" },
  // Nutrition
  { name: "Energy Gel Box (12)", brand: "Styrkr", cat: "nutrition" },
  { name: "Isotonic Energy Gel", brand: "Science in Sport", cat: "nutrition" },
  { name: "Energy Bar", brand: "Torq", cat: "nutrition" },
  { name: "Sport Electrolyte Tablets", brand: "Nuun", cat: "nutrition" },
  { name: "Endurance Fuel", brand: "Tailwind", cat: "nutrition" }
];

export function cacheKeyFor(brand, name) {
  return `price:${brand}|${name}`.toLowerCase();
}

// The words a hidden term's codename is picked from. Chosen to read as
// ordinary names while being rare in code, logs and shell output, so a
// codename in a tool call almost certainly came from a placeholder. When a
// session needs more names than these, a number follows (`Bubblegum2`).
// Keep every entry a single capitalized word of letters only: the guard
// finds codenames by that shape.

export const CODENAMES: readonly string[] = [
  'Bubblegum', 'Marmalade', 'Pinwheel', 'Kazoo', 'Snorkel', 'Gumdrop', 'Waffle', 'Pretzel',
  'Teacup', 'Walrus', 'Platypus', 'Porcupine', 'Accordion', 'Trombone', 'Tambourine', 'Lollipop',
  'Marshmallow', 'Doughnut', 'Periwinkle', 'Buttercup', 'Dandelion', 'Huckleberry', 'Gooseberry', 'Kumquat',
  'Persimmon', 'Rhubarb', 'Parsnip', 'Rutabaga', 'Artichoke', 'Butterscotch', 'Nougat', 'Toffee',
  'Meringue', 'Crumpet', 'Scone', 'Strudel', 'Popover', 'Macaroon', 'Biscotti', 'Cannoli',
  'Churro', 'Dumpling', 'Pancake', 'Flapjack', 'Muffin', 'Custard', 'Sherbet', 'Sorbet',
  'Gelato', 'Tapioca', 'Licorice', 'Fudge', 'Truffle', 'Praline', 'Brioche', 'Baguette',
  'Croissant', 'Bagel', 'Pierogi', 'Tamale', 'Empanada', 'Gnocchi', 'Ravioli', 'Tortellini',
  'Anchovy', 'Barnacle', 'Pelican', 'Flamingo', 'Penguin', 'Puffin', 'Toucan', 'Cockatoo',
  'Parakeet', 'Hummingbird', 'Kingfisher', 'Sandpiper', 'Heron', 'Albatross', 'Cormorant', 'Starling',
  'Wombat', 'Koala', 'Kangaroo', 'Wallaby', 'Armadillo', 'Aardvark', 'Anteater', 'Hedgehog',
  'Chipmunk', 'Marmot', 'Beaver', 'Otter', 'Badger', 'Ferret', 'Weasel', 'Mongoose',
  'Meerkat', 'Lemur', 'Sloth', 'Tapir', 'Okapi', 'Narwhal', 'Manatee', 'Dugong',
  'Octopus', 'Squid', 'Cuttlefish', 'Seahorse', 'Starfish', 'Jellyfish', 'Lobster', 'Crawfish',
  'Tortoise', 'Iguana', 'Chameleon', 'Gecko', 'Salamander', 'Axolotl', 'Newt', 'Tadpole',
  'Bumblebee', 'Ladybug', 'Dragonfly', 'Firefly', 'Grasshopper', 'Cricket', 'Caterpillar', 'Butterfly',
  'Harmonica', 'Bagpipe', 'Banjo', 'Ukulele', 'Mandolin', 'Xylophone', 'Glockenspiel', 'Bassoon',
  'Clarinet', 'Oboe', 'Piccolo', 'Tuba', 'Cowbell', 'Maraca', 'Didgeridoo', 'Ocarina',
  'Teapot', 'Kettle', 'Colander', 'Ladle', 'Spatula', 'Whisk', 'Thimble', 'Doorknob',
  'Lampshade', 'Umbrella', 'Galosh', 'Mitten', 'Earmuff', 'Scarf', 'Bonnet', 'Beret',
  'Sombrero', 'Fedora', 'Bowtie', 'Suspender', 'Cufflink', 'Monocle', 'Pocketwatch', 'Hourglass',
  'Telescope', 'Periscope', 'Kaleidoscope', 'Gyroscope', 'Metronome', 'Sextant', 'Astrolabe', 'Compass',
  'Lighthouse', 'Windmill', 'Gazebo', 'Pergola', 'Treehouse', 'Igloo', 'Wigwam', 'Chalet',
  'Carousel', 'Ferris', 'Trampoline', 'Seesaw', 'Hopscotch', 'Yoyo', 'Frisbee', 'Boomerang',
  'Pogostick', 'Scooter', 'Tricycle', 'Unicycle', 'Rickshaw', 'Gondola', 'Zeppelin', 'Dirigible',
  'Canoe', 'Kayak', 'Dinghy', 'Schooner', 'Tugboat', 'Paddleboat', 'Hovercraft', 'Submarine',
  'Snowglobe', 'Pinecone', 'Acorn', 'Chestnut', 'Walnut', 'Hazelnut', 'Pistachio', 'Cashew',
  'Coconut', 'Pineapple', 'Mango', 'Papaya', 'Guava', 'Lychee', 'Rambutan', 'Durian',
  'Tangerine', 'Clementine', 'Grapefruit', 'Pomelo', 'Apricot', 'Nectarine', 'Plum', 'Quince',
  'Cranberry', 'Blueberry', 'Raspberry', 'Blackberry', 'Elderberry', 'Mulberry', 'Boysenberry', 'Cloudberry',
  'Paprika', 'Nutmeg', 'Cinnamon', 'Saffron', 'Cardamom', 'Turmeric', 'Oregano', 'Tarragon',
  'Pumpernickel', 'Sourdough', 'Focaccia', 'Ciabatta', 'Pita', 'Naan', 'Tortilla', 'Chapati',
]

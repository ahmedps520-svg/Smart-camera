import { SCENES } from '../config/defaults.js';

/**
 * Maps on-device image-classifier labels (ImageNet-style), detected objects
 * (COCO labels), people count and lighting into Smart Camera's scene types.
 * Scene changes are sticky: a new scene must win for several consecutive
 * updates before it replaces the current one, so guidance does not flicker.
 */
const KEYWORDS = {
  food: ['pizza', 'burger', 'cheeseburger', 'hotdog', 'plate', 'sandwich', 'ice cream', 'espresso', 'cup', 'soup', 'bagel', 'pretzel', 'guacamole', 'carbonara', 'meat loaf', 'burrito', 'taco', 'sushi', 'broccoli', 'cauliflower', 'mushroom', 'orange', 'lemon', 'banana', 'strawberry', 'pineapple', 'pomegranate', 'cake', 'trifle', 'wine', 'bottle', 'bowl', 'donut', 'chocolate', 'dough', 'coffee', 'tray', 'restaurant', 'dining', 'french loaf', 'red wine', 'eggnog', 'consomme', 'hot pot', 'mashed potato', 'head cabbage', 'zucchini', 'cucumber', 'bell pepper', 'fig', 'jackfruit', 'custard', 'apple'],
  pet: ['dog', 'retriever', 'terrier', 'spaniel', 'poodle', 'husky', 'shepherd', 'bulldog', 'beagle', 'cat', 'tabby', 'siamese', 'persian', 'kitten', 'puppy', 'hound', 'collie', 'corgi', 'pug', 'dachshund', 'chihuahua', 'labrador', 'malamute', 'setter', 'pointer', 'schnauzer', 'mastiff', 'rottweiler', 'doberman', 'boxer', 'pinscher', 'shih', 'pekinese', 'papillon', 'maltese', 'bird', 'parrot', 'rabbit', 'hamster', 'guinea pig', 'egyptian cat', 'horse', 'cow', 'sheep'],
  vehicle: ['car', 'sports car', 'convertible', 'cab', 'jeep', 'limousine', 'minivan', 'pickup', 'racer', 'wagon', 'motorcycle', 'moped', 'scooter', 'bicycle', 'bike', 'truck', 'trailer', 'bus', 'train', 'locomotive', 'tram', 'streetcar', 'ambulance', 'fire engine', 'police van', 'tow truck', 'snowplow', 'garbage truck', 'go-kart', 'golfcart', 'speedboat', 'yawl', 'catamaran', 'airliner', 'airplane', 'boat', 'wheel', 'grille', 'car mirror', 'tractor', 'harvester', 'forklift', 'model t'],
  architecture: ['palace', 'church', 'mosque', 'monastery', 'castle', 'cathedral', 'dome', 'bell cote', 'tower', 'skyscraper', 'bridge', 'suspension bridge', 'viaduct', 'steel arch', 'triumphal arch', 'library', 'cinema', 'boathouse', 'barn', 'greenhouse', 'lighthouse', 'obelisk', 'fountain', 'monument', 'megalith', 'stupa', 'planetarium', 'prison', 'altar', 'window', 'facade', 'column', 'pier', 'dam', 'patio', 'home theater', 'bookshop', 'toyshop', 'grocery store', 'shoe shop', 'tobacco shop', 'butcher shop', 'barbershop', 'mobile home', 'thatch', 'tile roof', 'water tower', 'beacon'],
  landscape: ['alp', 'valley', 'volcano', 'cliff', 'promontory', 'geyser', 'lakeside', 'lakeshore', 'mountain', 'coral reef', 'glacier', 'canyon', 'forest', 'meadow', 'field', 'hill', 'river', 'waterfall', 'desert', 'dune', 'sky', 'cloud', 'park bench', 'maze', 'hay', 'rapeseed', 'daisy', 'yellow lady', 'corn', 'acorn', 'hip', 'buckeye', 'coral fungus', 'bolete', 'stone wall', 'picket fence', 'worm fence'],
  beach: ['seashore', 'beach', 'sandbar', 'coast', 'ocean', 'sea', 'surf', 'breakwater', 'groyne', 'seaside', 'lagoon', 'wreck', 'snorkel', 'bikini', 'swimming trunks', 'sunscreen', 'paddle', 'sandbar', 'pier'],
  street: ['street sign', 'traffic light', 'crosswalk', 'taxi', 'parking meter', 'manhole', 'mailbox', 'newsstand', 'street', 'alley', 'sidewalk', 'shopping cart', 'umbrella', 'trolleybus', 'minibus', 'pole', 'scoreboard', 'billboard', 'storefront'],
  product: ['bottle', 'perfume', 'watch', 'digital watch', 'lipstick', 'sunglasses', 'wallet', 'purse', 'backpack', 'shoe', 'sneaker', 'running shoe', 'loafer', 'sandal', 'cellular telephone', 'ipod', 'laptop', 'notebook', 'mouse', 'keyboard', 'monitor', 'headphone', 'camera', 'reflex camera', 'lens', 'vase', 'jewelry', 'necklace', 'ring', 'candle', 'mug', 'hair spray', 'lotion', 'packet', 'carton', 'toy', 'teddy', 'joystick', 'remote control', 'modem', 'speaker', 'microphone', 'guitar', 'violin', 'piano', 'sunglass', 'cowboy hat', 'sombrero', 'jersey', 't-shirt', 'sweatshirt', 'jean', 'book jacket', 'binder', 'pencil box', 'rubber eraser', 'ballpoint'],
  indoor: ['sofa', 'couch', 'studio couch', 'bed', 'desk', 'table', 'dining table', 'chair', 'rocking chair', 'bookcase', 'wardrobe', 'television', 'home theater', 'lamp', 'table lamp', 'shade', 'window shade', 'curtain', 'shower curtain', 'bathtub', 'toilet', 'washbasin', 'refrigerator', 'microwave', 'oven', 'stove', 'dishwasher', 'sink', 'kitchen', 'wall clock', 'radiator', 'fireplace', 'file cabinet', 'entertainment center', 'quilt', 'pillow', 'carpet', 'prayer rug', 'bath towel', 'crib', 'cradle', 'four-poster', 'china cabinet', 'medicine chest', 'plate rack', 'wine bottle', 'tv'],
};
const COCO = {
  food: ['pizza', 'donut', 'cake', 'sandwich', 'hot dog', 'banana', 'apple', 'orange', 'broccoli', 'carrot', 'bowl', 'cup', 'fork', 'knife', 'spoon', 'wine glass', 'dining table'],
  pet: ['dog', 'cat', 'bird', 'horse', 'sheep', 'cow'],
  vehicle: ['car', 'motorcycle', 'bus', 'truck', 'bicycle', 'train', 'boat', 'airplane'],
  street: ['traffic light', 'stop sign', 'fire hydrant', 'parking meter', 'bench'],
  indoor: ['couch', 'bed', 'tv', 'laptop', 'refrigerator', 'oven', 'sink', 'chair', 'potted plant', 'microwave', 'toaster'],
  product: ['bottle', 'cell phone', 'book', 'clock', 'vase', 'handbag', 'backpack', 'suitcase', 'tie', 'remote', 'mouse', 'keyboard', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'],
};

export class SceneClassifier {
  constructor({ switchAfter = 3, margin = 0.08 } = {}) {
    this.current = 'outdoor';
    this.candidate = null; this.candidateCount = 0;
    this.switchAfter = switchAfter; this.margin = margin;
    this.scores = {};
    this.confidence = 0;
  }

  static votes(labels, objects, tracked, lighting) {
    const v = Object.fromEntries(SCENES.map((s) => [s, 0]));
    for (const { label, score } of labels) {
      const l = label.toLowerCase();
      for (const [scene, words] of Object.entries(KEYWORDS)) if (words.some((w) => l.includes(w))) v[scene] += score;
    }
    for (const o of objects) {
      if (o.label === 'person') continue;
      for (const [scene, words] of Object.entries(COCO)) if (words.includes(o.label)) v[scene] += o.score * (o.box.w * o.box.h > 0.08 ? 0.9 : 0.4);
    }
    if (tracked.count === 1) {
      const sz = tracked.primary?.box.h || 0;
      v.portrait += sz > 0.25 ? 1.2 : 0.5;
    } else if (tracked.count > 1) v.group += 1.4;
    if (lighting) {
      if (lighting.isNight) v.night += 1.0;
      else if (lighting.isDark) v.night += 0.35;
      if (lighting.warmth > 1.35 && lighting.mean < 0.5 && !lighting.isNight) v.sunset += 0.7;
    }
    // Objects/animals dominate over "person in frame" only when the person is small.
    if (tracked.count >= 1 && (tracked.primary?.box.h || 0) > 0.35) { v.pet *= 0.5; v.vehicle *= 0.5; v.product *= 0.3; v.food *= 0.3; v.architecture *= 0.6; v.landscape *= 0.6; }
    return v;
  }

  /** @returns {{scene:string, confidence:number, scores:Object}} */
  update({ sceneLabels = [], objects = [], tracked, lighting }) {
    const v = SceneClassifier.votes(sceneLabels, objects, tracked, lighting);
    // EMA over votes for stability.
    for (const k of SCENES) this.scores[k] = (this.scores[k] ?? 0) * 0.7 + v[k] * 0.3;
    const sorted = Object.entries(this.scores).sort((a, b) => b[1] - a[1]);
    let [top, topScore] = sorted[0];
    if (topScore < 0.12) top = tracked.count ? (tracked.count > 1 ? 'group' : 'portrait') : (lighting?.isNight ? 'night' : 'outdoor');
    if (top !== this.current) {
      if (this.candidate === top) this.candidateCount++; else { this.candidate = top; this.candidateCount = 1; }
      if (this.candidateCount >= this.switchAfter && topScore > (this.scores[this.current] ?? 0) + this.margin) { this.current = top; this.candidate = null; this.candidateCount = 0; }
    } else { this.candidate = null; this.candidateCount = 0; }
    this.confidence = Math.min(1, topScore / 1.5);
    return { scene: this.current, confidence: this.confidence, scores: { ...this.scores } };
  }
}

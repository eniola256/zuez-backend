// ───────────────────────────────────────────────────────────────
// EDIT THIS FILE to change what is in the shop.
//
// The 13 pieces below are PLACEHOLDERS. To add a real piece:
//   1. Put its photos in the /public folder.
//   2. Add an entry like the template at the bottom of this list.
//   3. Give it a new, unique id. The product page is made for you.
//
// Fields
//   id           unique number (the product page lives at #/product/<id>)
//   name, price  price is a plain number, e.g. 28 (not "$28.00")
//   cat          "men" | "women" | "unisex"     -> menu filters
//   isNew        true puts it under the "New" filter
//   img          photo used on the shop grid
//   hoverImg     photo shown when hovering the shop grid
//   description  one or two sentences for the product page
//   sizes        ["S","M","L","XL"]. Leave [] for one-size pieces.
//   soldOut      sizes that can't be picked, e.g. ["XL"]
//   variants     the colours / styles shown on the product page.
//                If you leave it out, img and hoverImg are used as two styles.
// ───────────────────────────────────────────────────────────────

export const CURRENCY = { code: "USD", locale: "en-US" }; // e.g. { code: "NGN", locale: "en-NG" }

export function formatPrice(amount) {
  return new Intl.NumberFormat(CURRENCY.locale, {
    style: "currency",
    currency: CURRENCY.code,
  }).format(amount);
}

export const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "men", label: "Men" },
  { id: "women", label: "Women" },
  { id: "unisex", label: "Unisex" },
  { id: "new", label: "New" },
];

const APPAREL = ["S", "M", "L", "XL"];

export const PRODUCTS = [
  {
    id: 1,
    name: "Pinstripe Off-Duty Shorts",
    price: 28,
    cat: "unisex",
    isNew: true,
    img: "./t6.png",
    hoverImg: "./t6-hover.png",
    description:
      "Loose, knee-length shorts in a crisp pinstripe. Cut wide through the leg and made to be worn with loafers.",
    sizes: APPAREL,
  },
  {
    id: 2,
    name: "Borough Cap",
    price: 24,
    cat: "unisex",
    isNew: true,
    img: "./t2.png",
    hoverImg: "./t2-hover.png",
    description:
      "A deep green five-panel cap with a vintage skyline graphic embroidered across the front.",
    sizes: [],
  },
  {
    id: 3,
    name: "Raw Denim Wide-Leg",
    price: 32,
    cat: "men",
    isNew: true,
    img: "./t3.png",
    hoverImg: "./t3-hover.png",
    description:
      "Dark, unwashed denim with a wide, relaxed leg and contrast stitching.",
    sizes: APPAREL,
  },
  {
    id: 4,
    name: "Technical Sling Pack",
    price: 36,
    cat: "unisex",
    isNew: true,
    img: "./t4.png",
    hoverImg: "./t4-hover.png",
    description:
      "A black sling bag with a utility-first shape. Carry it across the body or on one shoulder.",
    sizes: [],
  },
  {
    id: 5,
    name: "Tank Watch",
    price: 48,
    cat: "unisex",
    isNew: false,
    img: "./t5.png",
    hoverImg: "./t5-hover.png",
    description:
      "A rectangular tank-style watch with a Roman-numeral dial and a tan leather strap.",
    sizes: [],
  },
  {
    id: 6,
    name: "Piped Tech Tee",
    price: 26,
    cat: "unisex",
    isNew: false,
    img: "./t1.png",
    hoverImg: "./t1-hover.png",
    description:
      "A black short-sleeve tee with contrast piping running along the seams.",
    sizes: APPAREL,
  },
  {
    id: 7,
    name: "Wide Leg Trousers",
    price: 34,
    cat: "men",
    isNew: false,
    img: "./t7.png",
    hoverImg: "./t7-hover.png",
    description:
      "Pleated, wide-leg trousers in black. Tailored in the waist, with room to move below it.",
    sizes: APPAREL,
  },
  {
    id: 8,
    name: "Good Luck Cap",
    price: 30,
    cat: "unisex",
    isNew: false,
    img: "./t13.png",
    hoverImg: "./t13-hover.png",
    description:
      "A cream five-panel cap with a hand-drawn good-luck graphic on the front.",
    sizes: [],
  },
  {
    id: 9,
    name: "Grey Sweat Shorts",
    price: 30,
    cat: "unisex",
    isNew: false,
    img: "./t9.png",
    hoverImg: "./t9-hover.png",
    description:
      "Soft, heathered grey sweat shorts with a loose, knee-length fit.",
    sizes: APPAREL,
  },
  {
    id: 10,
    name: "Striped Match Jersey",
    price: 22,
    cat: "men",
    isNew: false,
    img: "./t10.png",
    hoverImg: "./t10-hover.png",
    description:
      "A burgundy football-style jersey with a contrast collar and a crest on the chest.",
    sizes: APPAREL,
  },
  {
    id: 11,
    name: "Baggy Charm Jeans",
    price: 30,
    cat: "women",
    isNew: false,
    img: "./t11.png",
    hoverImg: "./t11-hover.png",
    description:
      "Washed, oversized jeans with a tie at the waist and charms hanging from the belt loops.",
    sizes: APPAREL,
  },
  {
    id: 12,
    name: "Grey Sweatpants",
    price: 26,
    cat: "unisex",
    isNew: false,
    img: "./t12.png",
    hoverImg: "./t12-hover.png",
    description:
      "Heathered grey sweatpants with a drawstring waist and a curved, relaxed leg.",
    sizes: APPAREL,
  },
  {
    id: 13,
    name: "Angel Boy Shirt",
    price: 15,
    cat: "men",
    isNew: false,
    img: "./t8.png",
    hoverImg: "./t8-hover.png",
    description:
      "A striped short-sleeve button-down with embroidered lettering on the chest.",
    sizes: APPAREL,
  },

  // ── TEMPLATE: copy this, remove the // and fill it in ──────────
  // {
  //   id: 14,
  //   name: "Your Piece",
  //   price: 40,
  //   cat: "unisex",
  //   isNew: true,
  //   img: "./your-piece-black.png",
  //   hoverImg: "./your-piece-black-back.png",
  //   description: "One or two sentences about it.",
  //   sizes: ["S", "M", "L", "XL"],
  //   soldOut: ["XL"],
  //   variants: [
  //     { id: "black", label: "Black", color: "#111111", img: "./your-piece-black.png" },
  //     { id: "cream", label: "Cream", color: "#E8E4DC", img: "./your-piece-cream.png" },
  //   ],
  // },
];

// The colours / styles for a piece. Uses `variants` if you set them,
// otherwise falls back to the grid photo and the hover photo.
export function getVariants(product) {
  if (product.variants?.length) return product.variants;
  return [
    { id: "style-1", label: "Style 1", img: product.img },
    { id: "style-2", label: "Style 2", img: product.hoverImg },
  ];
}

export function matchesFilter(product, filter) {
  if (filter === "all") return true;
  if (filter === "new") return product.isNew;
  return product.cat === filter;
}

/**
 * The household category set. Hard-coded on purpose (Alex, 2026-09-13): the list is
 * short, it is decided by "can we avoid this or not", and every page, picker and rule
 * refers to these keys. The key is the stable id stored in the ledger and the rules,
 * the labels are display only. `tier` is the DEFAULT for the category; a row can
 * override it through data/pins.csv (see pins.ts).
 */
export type CategoryKind = "spend" | "income" | "control";
export type Tier = "mandatory" | "optional";

export interface CategoryDef {
  key: string;
  ru: string;
  en: string;
  kind: CategoryKind;
  /** Default tier for spend categories; income and control carry none. */
  tier?: Tier;
  color?: string;
}

export const CATEGORIES: readonly CategoryDef[] = [
  { key: "housing", ru: "Жильё и коммуналка", en: "Housing & utilities", kind: "spend", tier: "mandatory", color: "#3d7fb2" },
  { key: "groceries", ru: "Продукты", en: "Groceries", kind: "spend", tier: "mandatory", color: "#3f9668" },
  { key: "transport", ru: "Транспорт", en: "Transport", kind: "spend", tier: "mandatory", color: "#54819f" },
  { key: "work-subs", ru: "Рабочие подписки", en: "Work subscriptions", kind: "spend", tier: "mandatory", color: "#8a63b8" },
  { key: "business-lunch", ru: "Бизнес-ланч", en: "Business lunch", kind: "spend", tier: "mandatory", color: "#b8892e" },
  { key: "household", ru: "Хозтовары и дом", en: "Household & home", kind: "spend", tier: "mandatory", color: "#ad8a4a" },
  { key: "health", ru: "Здоровье и красота", en: "Health & beauty", kind: "spend", tier: "mandatory", color: "#b5503f" },
  { key: "eating-out", ru: "Кафе и рестораны", en: "Eating out", kind: "spend", tier: "optional", color: "#cd6a38" },
  { key: "clothing", ru: "Одежда", en: "Clothing", kind: "spend", tier: "optional", color: "#b874a0" },
  { key: "kids", ru: "Дети", en: "Kids", kind: "spend", tier: "optional", color: "#d68a3a" },
  { key: "shopping", ru: "Покупки", en: "Shopping", kind: "spend", tier: "optional", color: "#c55a8b" },
  { key: "entertainment", ru: "Развлечения и игры", en: "Entertainment & games", kind: "spend", tier: "optional", color: "#9a5fae" },
  { key: "music", ru: "Музыка", en: "Music", kind: "spend", tier: "optional", color: "#a85570" },
  { key: "travel", ru: "Путешествия", en: "Travel", kind: "spend", tier: "optional", color: "#00958a" },
  { key: "other", ru: "Разное", en: "Other", kind: "spend", tier: "optional", color: "#98917f" },
  { key: "salary", ru: "Зарплата", en: "Salary", kind: "income" },
  { key: "kindergeld", ru: "Kindergeld", en: "Kindergeld", kind: "income" },
  { key: "benefits", ru: "Пособия", en: "Benefits", kind: "income" },
  { key: "anna-lessons", ru: "Уроки Ани", en: "Anna's lessons", kind: "income" },
  { key: "interest", ru: "Проценты и кэшбэк", en: "Interest & cashback", kind: "income" },
  { key: "Savings", ru: "Накопления", en: "Savings", kind: "control" },
  { key: "Exclude", ru: "Исключено", en: "Excluded", kind: "control" },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

export function categoryDef(key: string): CategoryDef | undefined {
  return BY_KEY.get(key);
}

export function categoryLabel(key: string, lang: "en" | "ru"): string {
  const c = BY_KEY.get(key);
  if (!c) return key === "" ? (lang === "ru" ? "Без категории" : "Uncategorized") : key;
  return lang === "ru" ? c.ru : c.en;
}

/** Spend categories whose default tier is mandatory. */
export function mandatoryCategoryKeys(): string[] {
  return CATEGORIES.filter((c) => c.kind === "spend" && c.tier === "mandatory").map((c) => c.key);
}

/** The pick list a retag control offers: spend categories, then income, in display order. */
export function pickableCategories(): readonly CategoryDef[] {
  return CATEGORIES.filter((c) => c.kind !== "control");
}

/**
 * Old free-text category names (the merchant-history accretion before 2026-09-13)
 * to the keys above. Used once by the migration and kept so an old rules file
 * still resolves. Two old names need the merchant to decide and are handled in
 * `legacyCategoryFor`: Subscriptions (work vs fun) and Eating out (business lunch).
 */
export const LEGACY: Readonly<Record<string, string>> = {
  "Rent & utilities": "housing", Rent: "housing", Utilities: "housing", Phone: "housing", Insurance: "housing", Admin: "housing",
  Groceries: "groceries",
  Commute: "transport", Transport: "transport", Micromobility: "transport",
  Subscriptions: "work-subs",
  "Business lunch": "business-lunch",
  "Eating out": "eating-out", Drinking: "eating-out",
  Drogerie: "household", Household: "household", Home: "household",
  Health: "health", Beauty: "health", Sport: "health", Fitness: "health",
  Clothing: "clothing",
  Kids: "kids",
  Shopping: "shopping",
  Entertainment: "entertainment", Gaming: "entertainment", Books: "entertainment",
  Music: "music", Band: "music",
  Travel: "travel",
  Other: "other", Miscellaneous: "other", PayPal: "other", Crypto: "other", Cash: "other", Bank: "other", Fees: "other", "Transfers out": "other",
  Salary: "salary", Kindergeld: "kindergeld", Benefits: "benefits", "Anna teaching": "anna-lessons", "From Anna": "Exclude",
  Savings: "Savings", Exclude: "Exclude",
};

/** Subscriptions that are fun, not work: they file under entertainment. */
export const FUN_SUBSCRIPTIONS = /netflix|spotify|youtube|patreon|apple|google|disney|amazon prime|prime video|hbo|twitch|audible|kindle|on that ass|beingpax|hanabi|muse app/i;
/** Cafes near the office: the business-lunch venues (the ratified list of 2026-06). */
export const BUSINESS_LUNCH = /lap coffee|louitorcafe|amrit|pizza peppino|nampan|mikkeller|wrapublic|chelany|nastys|spoonful|little green rabbit|xinh xinh|keyu|restaurantdiesel/i;
/** Income rows that were filed under the old "Bank" bucket. */
export const INTEREST = /cashback|interest on cash|выплата проц|ipid europe/i;

/** Resolve an old category name (plus the merchant, for the two ambiguous ones) to a key. */
export function legacyCategoryFor(oldCategory: string, merchantRaw: string): string {
  if (BY_KEY.has(oldCategory)) return oldCategory;
  if (oldCategory === "Subscriptions") return FUN_SUBSCRIPTIONS.test(merchantRaw) ? "entertainment" : "work-subs";
  if (oldCategory === "Eating out") return BUSINESS_LUNCH.test(merchantRaw) ? "business-lunch" : "eating-out";
  if (oldCategory === "Bank" && INTEREST.test(merchantRaw)) return "interest";
  return LEGACY[oldCategory] ?? oldCategory;
}

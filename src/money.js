// whole kobo / cents -> "₦17,000" or "$13"
export function money(minor, currency) {
  const major = minor / 100;
  return new Intl.NumberFormat(currency === "NGN" ? "en-NG" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
  }).format(major);
}

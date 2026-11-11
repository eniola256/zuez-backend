// Photos go from the browser straight to Cloudinary (they never pass through this
// server). We only hand the browser a short-lived signed permission slip.
import { createHash } from "node:crypto";

export const cloudinaryEnabled = () =>
  !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

// Cloudinary's rule: sort the params, join as a=1&b=2, append the secret, SHA-1.
export function signParams(params, apiSecret) {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(toSign + apiSecret).digest("hex");
}

export function uploadPermission() {
  const params = { folder: "zuez", timestamp: Math.floor(Date.now() / 1000) };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    apiKey: process.env.CLOUDINARY_API_KEY,
    ...params,
    signature: signParams(params, process.env.CLOUDINARY_API_SECRET),
  };
}

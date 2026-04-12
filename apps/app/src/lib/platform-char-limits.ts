export const PLATFORM_CHAR_LIMITS: Record<
  string,
  { maxChars: number; urlShortening?: number }
> = {
  twitter: { maxChars: 280, urlShortening: 23 },
  instagram: { maxChars: 2200 },
  facebook: { maxChars: 63206 },
  linkedin: { maxChars: 3000 },
  tiktok: { maxChars: 2200 },
  youtube: { maxChars: 5000 },
  pinterest: { maxChars: 500 },
  reddit: { maxChars: 40000 },
  bluesky: { maxChars: 300 },
  threads: { maxChars: 500 },
  telegram: { maxChars: 4096 },
  snapchat: { maxChars: 250 },
  googlebusiness: { maxChars: 1500 },
  whatsapp: { maxChars: 4096 },
  mastodon: { maxChars: 500 },
  sms: { maxChars: 1600 },
  discord: { maxChars: 2000 },
};

export function countCharsForPlatform(
  content: string,
  platform: string,
): number {
  const limits = PLATFORM_CHAR_LIMITS[platform];
  if (!limits?.urlShortening) return content.length;

  const urlRegex = /https?:\/\/[^\s]+/g;
  let count = content.length;
  const urls = content.match(urlRegex);
  if (urls) {
    for (const url of urls) {
      count -= url.length;
      count += limits.urlShortening;
    }
  }
  return count;
}

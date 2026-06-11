// Google Places API (New) Text Search client.
// One field-masked request returns up to 20 candidates with phone numbers,
// ratings, price level and open-now — everything the calling pipeline needs.
// ToS note: results are returned to the model for immediate use and are NOT
// persisted (only place_id may be stored; numbers we actually dial enter our
// own call log at call time).

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

// Every Enterprise-SKU field in one request (~$0.035, first 1,000/month free)
// beats search + 20 Place Details calls (~$0.43/survey).
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.businessStatus",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.internationalPhoneNumber",
  "places.currentOpeningHours.openNow",
].join(",");

export function placesConfigured(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY);
}

export interface BusinessCandidate {
  place_id: string;
  name: string;
  address?: string;
  phone: string | null;
  rating?: number;
  user_rating_count?: number;
  price_level?: string;
  open_now?: boolean;
  business_status?: string;
  distance_m?: number;
}

interface RawPlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  businessStatus?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  internationalPhoneNumber?: string;
  currentOpeningHours?: { openNow?: boolean };
}

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

// "PRICE_LEVEL_MODERATE" -> "$$" etc.; unknown values pass through raw.
const PRICE_LEVELS: Record<string, string> = {
  PRICE_LEVEL_FREE: "free",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

export async function searchBusinesses(args: {
  query: string;
  languageCode?: string;
  lat?: number;
  lng?: number;
  radiusM?: number;
  openNow?: boolean;
  maxResults?: number;
}): Promise<{ candidates: BusinessCandidate[]; droppedWithoutPhone: number }> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY is not configured on this server.");
  }

  const body: Record<string, unknown> = {
    textQuery: args.query,
    pageSize: Math.min(Math.max(args.maxResults ?? 20, 1), 20),
  };
  if (args.languageCode) body.languageCode = args.languageCode;
  if (args.openNow) body.openNow = true;
  if (args.lat != null && args.lng != null) {
    body.locationBias = {
      circle: {
        center: { latitude: args.lat, longitude: args.lng },
        // Places caps circle radius at 50km.
        radius: Math.min(Math.max(args.radiusM ?? 5000, 100), 50000),
      },
    };
  }

  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      message = parsed.error?.message ?? message;
    } catch {
      // keep raw text
    }
    throw new Error(`Places API ${res.status}: ${message}`);
  }

  const places: RawPlace[] = text ? (JSON.parse(text).places ?? []) : [];
  let droppedWithoutPhone = 0;
  const candidates: BusinessCandidate[] = [];
  for (const p of places) {
    // Places returns "+972 3-123-4567" style; normalize to dialable E.164.
    // Numbers with extensions ("ext. 12") or odd formats fail validation and
    // are dropped — a corrupted number must never reach the dialer.
    const phone = p.internationalPhoneNumber?.replace(/[^+\d]/g, "");
    if (!phone || !/^\+\d{7,15}$/.test(phone)) {
      droppedWithoutPhone++;
      continue; // a candidate we can't call is useless to this pipeline
    }
    candidates.push({
      place_id: p.id,
      name: p.displayName?.text ?? "(unnamed)",
      address: p.formattedAddress,
      phone,
      rating: p.rating,
      user_rating_count: p.userRatingCount,
      price_level: p.priceLevel ? (PRICE_LEVELS[p.priceLevel] ?? p.priceLevel) : undefined,
      open_now: p.currentOpeningHours?.openNow,
      business_status: p.businessStatus,
      distance_m:
        args.lat != null && args.lng != null && p.location?.latitude != null && p.location?.longitude != null
          ? haversineMeters(args.lat, args.lng, p.location.latitude, p.location.longitude)
          : undefined,
    });
  }
  return { candidates, droppedWithoutPhone };
}

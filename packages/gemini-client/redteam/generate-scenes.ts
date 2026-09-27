// One-off: generate the realistic scene photos for the red-team set with
// Gemini's image model on Vertex AI (~US$0.04 per image). Skips scenes that
// already exist, so re-running costs nothing. Then run make-images.py to
// resize to JPEG and build the synthetic adversarial images.
//   GOOGLE_CLOUD_PROJECT=vayusetu-ncr-dev npx tsx redteam/generate-scenes.ts
//
// These are SYNTHETIC photos (stated in README.md): good for exercising the
// prompt's decision rules, not a substitute for real citizen photos.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const STYLE =
  'A realistic smartphone photo taken at eye level by an ordinary person, natural colours, slight noise, no text, no captions, no watermark.';

export const SCENES: Record<string, string> = {
  garbage_fire: 'Roadside in a North Indian city: a pile of garbage burning, thick grey-white smoke drifting across the road, parked scooters, overcast morning.',
  stubble_fire: 'A harvested paddy field in Punjab in late October: rows of stubble burning, a long low wall of fire and dense brown smoke drifting across the flat field, a tractor in the distance.',
  clear_sky: 'A clean residential street in an Indian city on a bright clear day: deep blue sky, crisp distant buildings, green trees, light traffic.',
  winter_fog: 'An Indian highway at dawn in January in dense radiation fog: white uniform fog, headlights glowing, visibility about 50 metres, damp road, no smoke source visible.',
  cooling_tower: 'A thermal power plant seen from a village road: two hyperbolic cooling towers releasing brilliant white water-vapour plumes into a blue sky.',
  construction_dust: 'A large construction site in Gurugram: an excavator digging, a truck unloading sand, clouds of beige dust rising and drifting over the site and the adjacent road.',
  traffic_haze: 'A congested Delhi arterial road at evening rush hour: rows of cars, buses and auto-rickshaws, a brownish grey haze over the road, distant flyover faded by smog.',
  factory_chimney: 'An industrial area on the outskirts of an Indian city: a brick-kiln style chimney emitting thick black smoke into a pale sky, low sheds around it.',
  kitchen_indoor: 'Inside a home kitchen: a pressure cooker on a gas stove, spice jars on a shelf, a little steam from the cooker, warm indoor lighting.',
  sunset_haze: 'Sunset over a city skyline seen from a rooftop: vivid orange and pink sky, sun near the horizon, silhouetted water tanks and buildings.',
};

const dir = fileURLToPath(new URL('./images/src/', import.meta.url));
mkdirSync(dir, { recursive: true });
const ai = new GoogleGenAI({ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT, location: 'global' });

for (const [id, prompt] of Object.entries(SCENES)) {
  const out = `${dir}${id}.png`;
  if (existsSync(out)) continue;
  // The image model's per-minute quota is small: back off on 429.
  let r;
  for (let attempt = 1; ; attempt++) {
    try {
      r = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: [{ role: 'user', parts: [{ text: `${prompt} ${STYLE}` }] }],
        config: { responseModalities: ['IMAGE'] },
      });
      break;
    } catch (e) {
      if ((e as { status?: number }).status !== 429 || attempt >= 6) throw e;
      await new Promise((ok) => setTimeout(ok, 20_000 * attempt));
    }
  }
  const data = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!data) {
    console.error(`${id}: no image returned`);
    continue;
  }
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(`${id}: ok`);
}

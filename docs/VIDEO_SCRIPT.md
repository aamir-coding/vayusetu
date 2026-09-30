# VayuSetu: demo video script (≈ 4 min 30 s)

A single take of the live system, cut into 9 scenes. It's based on the rehearsed [DEMO.md](DEMO.md), trimmed to the submission's 3–5 minute limit. Record at **1920×1080**, with a clear microphone. Cursor highlighting helps.

## Before you record (15 min)

1. **Warm every service.** Everything scales to zero, and a cold start adds 8–10 s. Open each app once and click through the citizen app, the Alert Queue, the Hotspot Map, Forecast and Federation.
2. **Three browser windows, all signed in before recording.** Never type a password on camera.
   - **A:** a Chrome profile in mobile emulation (DevTools → device toolbar, e.g. Pixel 7), https://vayusetu-ncr-dev.web.app, set to **हिन्दी**. This is citizen Rina.
   - **B:** a second Chrome profile, also in mobile emulation, on the same citizen URL. This is the second citizen; a separate profile counts as a different person.
   - **C:** a normal window on https://vayusetu-ncr-dev-admin.web.app, signed in as `district_admin`. Have `state_admin` ready in another profile for scene 7.
3. **Clear the demo cell.** In the district console, make sure nothing is open for Karol Bagh (cell `883da11623fffff`); an open alert there suppresses a new one. See DEMO.md §2.6.
4. **Location:** Karol Bagh, **28.65041, 77.19009** (Report → Change → type it). It routes to DL-CENTRAL, the demo officer's district.
5. **Photo:** a real one of smoke or garbage burning, or `packages/gemini-client/redteam/images/garbage_fire.jpg`. If you use the generated image, say "test photo" on screen.
6. **Close Slack, mail and notifications.** Hide the bookmarks bar.

## Scenes

| # | Time | Screen | Do | Say (suggested) |
|---|---|---|---|---|
| 1 | 0:00–0:20 | **vayusetu.web.app**, hero | Slow scroll to "Choose your state" | "Delhi has about forty air monitors for fifteen hundred square kilometres. Pollution starts between them, and the person breathing it has no way to tell anyone who can act. VayuSetu changes that." |
| 2 | 0:20–1:15 | **Window A**, citizen in Hindi | Choose the photo, **record a voice note in Hindi** ("यहाँ कूड़ा जल रहा है…"), set the location, **Send**. Wait for the Air Snapshot and press **सलाह सुनें** (play) | "Rina reports in Hindi: a photo, a voice note, no sign-up. In seconds Gemini on Vertex AI identifies open waste burning, rates it severe, checks it against the nearest monitor and satellite data, and gives advice in Hindi, read aloud by Cloud Text-to-Speech." |
| 3 | 1:15–1:35 | **Window B**, second citizen | Same photo and location → Send | "A second, independent citizen reports the same spot. VayuSetu counts people, not reports: one phone can never raise an alert on its own." |
| 4 | 1:35–2:25 | **Window C**, Alert Queue | The new alert appears live, with no refresh. Open it, scroll the **briefing, actions, advisory, cited signals**, then click **Acknowledge** and **In progress**. Show the audit trail growing | "Under a minute later it's on Officer Deshmukh's queue, and only his, because the cell is in his district. Gemini 3.1 Pro wrote this briefing, and every claim must cite a signal. Each step he takes is audited." |
| 5 | 2:25–2:55 | Hotspot Map | Zoom to Karol Bagh and click the red cell: signals and 7-day history. Mention an **amber-outlined** hidden hotspot if one is visible | "Every 0.7 square-kilometre cell is scored by an AutoML model over Sentinel-5P, fire and weather data from Earth Engine, and fused with citizen reports. A hotspot far from any monitor is flagged hidden: exactly what the official network can't see." |
| 6 | 2:55–3:15 | Forecast | Show the 72 h chart, GRAP stage per horizon and key drivers | "Vertex AI AutoML forecasts the next three days and the GRAP stage they imply, so restrictions can start before the peak." |
| 7 | 3:15–3:45 | **state_admin** → Federation | Shared Models (Delhi's models, with their quality-gate metric), then Cross-state View | "Each state runs its own deployment; citizens' data never leaves it. States share anonymised summaries and trained models through a National Exchange. Mumbai–Pune went live in about a day from the same code." |
| 8 | 3:45–4:05 | Admin, any screen | Switch language to **हिन्दी**, then toggle **Lite Mode** | "Every screen works in Hindi, Punjabi, Marathi and English, with a Lite Mode for 2G." |
| 9 | 4:05–4:30 | vayusetu.web.app, or the deck's closing slide | End on the link | "Red-teamed, load-tested, live in two states, and built entirely on Google Cloud. Every breath, heard. Every hotspot, seen. Try it at vayusetu.web.app." |

## If something goes wrong on camera
- **The Snapshot spins for more than 20 s:** a cold start. Keep talking over it, or cut the wait in editing.
- **Two reports, but no alert:** Gemini sometimes rates the same photo 3 instead of 4, and two severity-3 reports fall just short of the alert line. Send a third report from another profile (DEMO.md §4). Or check that the demo cell had no open alert.
- **You'd rather not risk it live:** record scenes 2–4 once as a clean take, then record the rest.

## After recording
- Trim dead time, and keep the whole thing between 3 and 5 minutes.
- Add captions. At least put the English meaning under the Hindi voice note.
- Upload **unlisted** to YouTube or Drive, and check the link opens while signed out.

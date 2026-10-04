# Manual test plan (on device)

Run on an iPhone (Safari, installed to Home Screen) and an iPad. Mark each row pass/fail.

| # | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| 1 | No person | Smart Photo, point at an empty wall / sky | "Point at a subject" (or horizon/level guidance for landscapes). No composition box, no auto capture in Smart Pose ("Looking for a person") |
| 2 | One person | Smart Photo, person 2–4 m away | Dashed subject box tracks them; orange "SUBJECT HERE" box on a third; pill gives one direction at a time; turns green PERFECT when inside |
| 3 | Multiple people | 2–4 people | "N people" in the subline; group box; "Person on the right is too close to the edge" / "Move back" / "Everyone is in frame" |
| 4 | Moving person | Person walks across | Guidance changes at most every ~1 s, never LEFT/RIGHT flicker; Smart Pose shows "Hold still", no capture while moving |
| 5 | Static pose | Smart Pose, person holds a pose, well framed | Scores rise; shutter ring turns green; ring fills (hold); "Perfect" countdown; photo taken; same pose not retaken; new pose retakes after cooldown |
| 6 | Poor lighting | Dim room | Lighting score low; "Too dark — move toward the light"; Night filter suggested; capture still works |
| 7 | Backlighting | Person in front of a bright window | "Subject is backlit"; lighting score penalised; suggestion to turn toward the light |
| 8 | Landscape | Outdoor horizon, no people | Scene chip LANDSCAPE/BEACH; dashed horizon estimate; "Tilt up/down" to put the horizon on a third; "Level camera" when tilted > ~2° |
| 9 | Architecture | Building facade | Scene chip ARCHITECTURE; symmetry influences framing; strict level guidance; High Contrast / B&W suggested |
| 10 | Objects | Food plate / product on a table | Scene chip FOOD/PRODUCT; centred composition box; 2× suggested when available; Warm / High Contrast looks |
| 11 | Zoom changes | Pinch, slider, chips | Preview zoom follows; capture is cropped to the same framing; recommended chip shows a green dot; recommendation only changes after ~0.6 s |
| 12 | Lens changes | Control panel → Lens → ultra wide / telephoto | Stream restarts on the new camera; presets update; analysis continues |
| 13 | Camera rotation | Rotate to landscape | Layout moves controls to the side; horizon guide stays correct; overlay stays aligned with the video |
| 14 | Permission denial (camera) | Deny camera | Gate explains how to re-enable; "Try again" works after enabling |
| 15 | Photos permission | Share → Save Image, deny Photos access | Share sheet handles it; app shows no error, photo stays in the app library |
| 16 | No internet | Airplane mode after first visit | App opens from the Home Screen, models load from cache, all modes work |
| 17 | Low battery | Below 20 %, unplugged (Android/Chrome) | Analysis tier drops ("low battery" in the panel readout); preview unaffected. iOS has no Battery API: no change expected |
| 18 | Thermal throttling | Run Smart Pose for 10+ minutes | Panel readout drops from high → balanced → low as inference slows; AI dot turns amber/red; preview stays smooth; recovers when cool |
| 19 | iPhone | All of the above | — |
| 20 | iPad | Front/rear, both orientations | Layout fills the screen, 1× / 2× presets, pose detection works |
| 21 | Front camera | Flip | Mirrored preview (configurable); captured file is mirrored to match the preview; composition box mirrored correctly |
| 22 | Timer + flash | 3 s / 10 s, flash on/auto | Countdown ring with ticks; torch fires during capture where supported |
| 23 | Review & library | Capture, retake, favourite, share, filter export | Original unchanged; filtered export is a separate copy; favourite persists; library grid shows AUTO badge |
| 24 | AI off | Tap ON-DEVICE pill or panel toggle | Pill shows AI OFF; no overlays or guidance; shutter and zoom still work |

# Android screenshot acceptance checklist

No inherited screenshots are included. Capture the running Android UI using the
synthetic room fixture and generated tone/image. Review every image visually and
remove metadata before accepting it. Static mockups do not verify Android behavior.

- Blank setup and HTTP opt-in; pending, expired and approved pairing.
- Playing scene, clock/date, pause indicator and restored resume position.
- Each of the six scenes; local effects, decoration and dimming controls.
- D-pad focus between scene and controls; timer preset/Off selection and Back.
- Countdown, duck/chime/restore, pause during expiry and zero-volume expiry.
- Guest join QR beside clock/message; renewed token and expiry during outage.
- Queue display, current-track removal with continuation, and empty queue.
- Banner, card and confetti messages; expired message during outage.
- Generated photo, failed-photo fallback and selected scene reset.
- Device 401/expiry, disconnect and pairing again.

Queue editing and guest moderation screenshots require the companion host remote;
the device token cannot perform those operations. Check their effect on this
renderer using the same synthetic room. Home/Back teardown and OEM audio focus
also require Android execution. No screenshots have been accepted in this candidate.

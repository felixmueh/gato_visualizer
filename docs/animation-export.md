# Animation export

Click **Export animation** in the viewport to download an MP4 of the aggregate
window, from its beginning to its end. Clearing the aggregate bounds uses the
whole session. Export needs a nonempty time range and a visible recorded track.

The movable dialog offers 720p (1280 × 720), 1080p (1920 × 1080), 1440p
(2560 × 1440), and 2160p (3840 × 2160). Choose **Main view** or
**Main + Top and Right**: the latter places the main view on the left and stacks
Top above Right in the right column. **Main camera** offers Current viewport,
Isometric, Front, Back, Left, Right, and Top. Current viewport preserves the
camera's framing, adding letterboxing within its output pane when the aspect
ratios differ. Isometric uses the orientation cube's front-right-top corner.
Defaults are 1080p, Main view, and Current viewport; choices persist per viewer.
**Cancel** or closing the dialog cancels an active export.

## Capture contract

Clicking **Export MP4** freezes the aggregate bounds, camera, and currently
visible active tracks. Track offsets, colours, and Arm/Dot representation are
retained. Replay mode excludes Live. In Live, export reads the available
recorded history; it reports an error if that history has not yet loaded the
requested range. Later session edits or new samples do not extend the export.

Frames use session time at a fixed 30 fps, computed from the frame index rather
than wall-clock playback. The schedule includes the exact aggregate end; the
final pose holds for one video frame. Playback speed does not change the
export's time scale. Capture uses a separate scene and renderer, leaving the
interactive cursor, numerical state, and presentation settings unchanged. It
starts no simulation or solver work and needs no solver GPU lease.

The video includes robot motion, visible track paths, reference geometry, and
the displayed prediction. It excludes editor handles, panels, and other browser
controls. The capture scene reconstructs presentation geometry; it does not
promise a pixel-identical copy of all viewport overlays or onion-skin ghosts.

## Encoding and ownership

[src/animation-export-dialog.js](../src/animation-export-dialog.js) owns the
settings and cancellation UI. [src/animation-export.js](../src/animation-export.js)
freezes the capture, samples frames, and uploads PNGs sequentially through
`/api/animation-export/start`, `frame`, and `finish`.
[server.py](../server.py) routes these requests to
[animation_export.py](../animation_export.py), which streams the PNGs directly
to a CPU ffmpeg process. The browser downloads the finished MP4 through the
returned `download_url`; `cancel` stops abandoned work. Encoding does not depend
on WebCodecs or a browser secure context.

The backend uses system `ffmpeg` first, then the project's
`node_modules/ffmpeg-static/ffmpeg` dependency. Set `TIAGO_VISUALIZER_FFMPEG` to
choose an executable explicitly. The read-only `/api/animation-export/status` checks availability; an encoder
process starts only for an export. An older running backend keeps the MP4 action
disabled until it is restarted. Export never restarts a backend or resets Live
history on its own.

Jobs and MP4 data live in the shared runtime directory's `animation-exports`
area, following the existing tmpfs and process-owner conventions. PNGs stream
to the encoder rather than accumulating as files. Download completion,
cancellation, encoding failure, or expiry removes job data; abandoned uploads
and results expire after 15 minutes. Server shutdown and startup cleanup also
remove owned or ended-owner jobs. The service admits at most two jobs, limits
each PNG to 32 MiB, each export to 108,000 frames, and its MP4 to 512 MiB.

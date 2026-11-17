import { useI18n } from "../i18n/I18n";
import { usePlayerStore } from "../player";
import { RemixIcon, Magnet } from "../icons/RemixIcons";
import { RippleEditIcon } from "./icons/RippleEditIcon";
import { Tooltip } from "./ui";
import { flatActive, flatIdle } from "./timelineToolbarStyles";
import { keyHint, useStudioKeys } from "../player/components/studioShortcuts";
import { trackStudioClick } from "../motion/editorTracking";

export function TimelineBehaviorToggles() {
  const { t } = useI18n();
  const keys = useStudioKeys();
  const timelineSnapEnabled = usePlayerStore((s) => s.timelineSnapEnabled);
  const setTimelineSnapEnabled = usePlayerStore((s) => s.setTimelineSnapEnabled);
  const timelineLinkageEnabled = usePlayerStore((s) => s.timelineLinkageEnabled);
  const setTimelineLinkageEnabled = usePlayerStore((s) => s.setTimelineLinkageEnabled);
  const rippleEditEnabled = usePlayerStore((s) => s.rippleEditEnabled);
  const setRippleEditEnabled = usePlayerStore((s) => s.setRippleEditEnabled);
  return <>
          <Tooltip
            side="bottom"
            label={t("Snapping ({value0})", { value0: keyHint("timelineSnap", keys) })}
          >
            <button
              type="button"
              onClick={() => {
                trackStudioClick("timeline", "snap_toggle", undefined, undefined, timelineSnapEnabled ? "off" : "on");
                setTimelineSnapEnabled(!timelineSnapEnabled);
              }}
              aria-label={t("Snapping")}
              aria-pressed={timelineSnapEnabled}
              className={timelineSnapEnabled ? flatActive : flatIdle}
            >
              <Magnet size={16} weight="bold" aria-hidden="true" />
            </button>
          </Tooltip>
<Tooltip
            label={
              rippleEditEnabled
                ? t("Main track magnet")
                : t("Main track magnet")
            }
          >
            <button
              type="button"
              onClick={() => setRippleEditEnabled(!rippleEditEnabled)}
              aria-label={t("Main track magnet")}
              aria-pressed={rippleEditEnabled}
              className={rippleEditEnabled ? flatActive : flatIdle}
            >
              <RippleEditIcon size={16} />
            </button>
          </Tooltip>
          <Tooltip label={t("Timeline linkage")}>
            <button type="button" aria-label={t("Timeline linkage")}
              aria-pressed={timelineLinkageEnabled}
              onClick={() => setTimelineLinkageEnabled(!timelineLinkageEnabled)}
              className={timelineLinkageEnabled ? flatActive : flatIdle}>
              <RemixIcon name="link" size={16} />
            </button>
          </Tooltip>
  </>;
}

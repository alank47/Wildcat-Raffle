/**
 * The Wildcat mark, as an inline data URI.
 *
 * Inline because PillNav takes `logo` as an <img> src and a school Chromebook on
 * a slow link should not have a second request between a student and their
 * timetable. Drawn as a stroked path rather than <text>, because a font inside
 * an <img> does not inherit the page's @font-face and renders as whatever the
 * platform happens to have.
 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="32" fill="#0C447C"/>
  <path d="M13 20 L22 46 L32 29 L42 46 L51 20"
        fill="none" stroke="#E6E280" stroke-width="6.5"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const WILDCAT_MARK = `data:image/svg+xml,${encodeURIComponent(SVG)}`;

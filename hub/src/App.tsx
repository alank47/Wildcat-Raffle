import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import PillNav from "@/components/PillNav";
import { useSession } from "@/lib/session";
import { useReducedMotion } from "@/lib/motion";
import { WILDCAT_MARK } from "@/ui/mark";
import { DemoBanner, RouteFrame } from "@/ui/primitives";
import SignIn from "@/routes/SignIn";
import Cards from "@/routes/Cards";
import Schedule from "@/routes/Schedule";
import Grades from "@/routes/Grades";
import HallPass from "@/routes/HallPass";

const NAV = [
  { label: "Cards", href: "/cards" },
  { label: "Schedule", href: "/schedule" },
  { label: "Grades", href: "/grades" },
  { label: "Pass", href: "/pass" },
];

export default function App() {
  const { signedIn, demo, signOut, me } = useSession();
  const location = useLocation();
  const reduced = useReducedMotion();

  if (!signedIn) {
    return (
      <Routes>
        <Route path="*" element={<SignIn />} />
      </Routes>
    );
  }

  return (
    <div className="wp-lift relative min-h-dvh">
      <div className="relative mx-auto w-full max-w-[560px]">
        {/* PillNav positions itself absolutely at top:1em inside the nearest
            positioned ancestor. That ancestor is the content column, so the nav
            lines up with the cards under it instead of floating in the corner of
            a 1440px window; the header reserves the height it will take. */}
        <header className="relative h-[74px]">
          <PillNav
            logo={WILDCAT_MARK}
            logoAlt="Westbrook Academy"
            items={NAV}
            activeHref={location.pathname}
            /* Both halves of the pill stay inside the school's blues. React
               Bits pairs a light capsule with dark pills, which leaves a pale
               hourglass of capsule showing in every gap between two rounded
               pills — on this dark ground that read as flashes of white. Two
               close blues keep the hover flood legible and the seams quiet. */
            baseColor="#2F67A7"
            pillColor="#0C447C"
            pillTextColor="#EAF2FB"
            hoveredPillTextColor="#FFFFFF"
            ease="power3.out"
            initialLoadAnimation={!reduced}
            className="!px-4 md:!px-4"
          />
        </header>
      </div>

      <main className="relative z-1 mx-auto w-full max-w-[560px] px-4 pb-16">
        {demo && <DemoBanner mode={demo} />}

        {/* Keyed on the path: the entrance is a CSS animation and a CSS
            animation only plays on a NEW element, so a fresh key per route is
            what turns a one-off on first paint into a route transition. */}
        <RouteFrame routeKey={location.pathname}>
          <Routes location={location}>
            <Route path="/" element={<Navigate to="/cards" replace />} />
            <Route path="/cards" element={<Cards />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/grades" element={<Grades />} />
            <Route path="/pass" element={<HallPass />} />
            <Route path="*" element={<Navigate to="/cards" replace />} />
          </Routes>
        </RouteFrame>

        <footer className="mt-12 border-t border-[var(--wp-hair)] pt-5">
          <p className="text-[11.5px] leading-[1.6] text-wp-dim">
            {me.state === "ok" && me.data.email
              ? `Signed in as ${me.data.email}.`
              : "Westbrook Academy."}
          </p>
          {!demo && (
            <button
              type="button"
              onClick={signOut}
              className="wc-press wc-hover-raise mt-3 rounded-full border border-[var(--wp-hair)] bg-white/[0.03] px-4 py-2 text-[12.5px] font-bold text-wp-dim"
            >
              Sign out
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}

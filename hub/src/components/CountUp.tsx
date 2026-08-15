import { useMotionValue, useSpring } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

interface CountUpProps {
  to: number;
  from?: number;
  direction?: 'up' | 'down';
  delay?: number;
  duration?: number;
  className?: string;
  startWhen?: boolean;
  separator?: string;
  onStart?: () => void;
  onEnd?: () => void;
}

/**
 * WILDCAT CHANGES — and the first one is a data-integrity bug, not a motion one.
 *
 * 1. THE OFF-SCREEN ZERO. As published this renders `from` (0) into the DOM on
 *    mount and only counts toward `to` once motion's `useInView` reports the
 *    span on screen. So every figure below the fold rendered as a hard ZERO
 *    until a student scrolled to it. On the Grades screen that meant "Absent,
 *    term: 0" and "Absent, year: 0" sitting under a panel that had to be
 *    scrolled to reach, on a student with five absences — an invented value, in
 *    the one app whose entire premise is that a missing figure is never printed
 *    as a real one. Verified in the browser: the three attendance tiles read
 *    0 / 0 / 0 indefinitely while the three above them read correctly.
 *
 *    The IntersectionObserver is gone. The count now starts on mount, which for
 *    a 700ms roll means an off-screen figure is finished and correct long
 *    before anyone scrolls to it, and there is no viewport condition standing
 *    between a number and being right.
 *
 * 2. THE FLOOR. `from` is written before paint, in a layout effect, so there is
 *    no frame where the final value shows and then snaps back to zero.
 *
 * 3. THE BACKSTOP, and it fixes a SECOND wrong number. A timer at delay +
 *    duration + 200ms writes the true value outright and then stops listening
 *    to the spring for good.
 *
 *    Both halves are needed. The spring is heavily overdamped at these
 *    durations (damping 77, stiffness 143 for a 0.7s count) so it approaches
 *    its target asymptotically and motion calls it settled while it is still
 *    short — a figure with a decimal place would come to rest displaying 90.9%
 *    when the student's average was 91.6%, permanently, and only decimals show
 *    it because an integer count rounds the shortfall away. Latching after the
 *    write is what stops the next creeping frame from undoing it.
 *
 *    It also covers the stall case: if the spring never ticks at all — a frozen
 *    rAF in a backgrounded tab is exactly how this app lost its sign-in button
 *    once already — the number still ends up correct rather than stuck at zero.
 *    An animation is allowed to fail. It is not allowed to leave a wrong number
 *    on screen.
 */
export default function CountUp({
  to,
  from = 0,
  direction = 'up',
  delay = 0,
  duration = 2,
  className = '',
  startWhen = true,
  separator = '',
  onStart,
  onEnd
}: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  /** Latched by the backstop. Once true, the spring may not write again. */
  const settled = useRef(false);
  const motionValue = useMotionValue(direction === 'down' ? to : from);

  const damping = 20 + 40 * (1 / duration);
  const stiffness = 100 * (1 / duration);

  const springValue = useSpring(motionValue, {
    damping,
    stiffness
  });

  const getDecimalPlaces = (num: number): number => {
    const str = num.toString();
    if (str.includes('.')) {
      const decimals = str.split('.')[1];
      if (parseInt(decimals) !== 0) {
        return decimals.length;
      }
    }
    return 0;
  };

  const maxDecimals = Math.max(getDecimalPlaces(from), getDecimalPlaces(to));

  const formatValue = useCallback(
    (latest: number) => {
      const hasDecimals = maxDecimals > 0;

      const options: Intl.NumberFormatOptions = {
        useGrouping: !!separator,
        minimumFractionDigits: hasDecimals ? maxDecimals : 0,
        maximumFractionDigits: hasDecimals ? maxDecimals : 0
      };

      const formattedNumber = Intl.NumberFormat('en-US', options).format(latest);

      return separator ? formattedNumber.replace(/,/g, separator) : formattedNumber;
    },
    [maxDecimals, separator]
  );

  // Before paint, so the starting figure is never seen replacing a final one.
  useLayoutEffect(() => {
    settled.current = false;
    if (ref.current) {
      ref.current.textContent = formatValue(direction === 'down' ? to : from);
    }
  }, [from, to, direction, formatValue]);

  useEffect(() => {
    if (!startWhen) return;

    onStart?.();

    const startId = setTimeout(() => {
      motionValue.set(direction === 'down' ? from : to);
    }, delay * 1000);

    const endId = setTimeout(
      () => {
        onEnd?.();
      },
      delay * 1000 + duration * 1000
    );

    // The backstop. See note 3 above.
    const settleId = setTimeout(
      () => {
        settled.current = true;
        const final = formatValue(direction === 'down' ? from : to);
        if (ref.current && ref.current.textContent !== final) {
          ref.current.textContent = final;
        }
      },
      delay * 1000 + duration * 1000 + 200
    );

    return () => {
      clearTimeout(startId);
      clearTimeout(endId);
      clearTimeout(settleId);
    };
  }, [startWhen, motionValue, direction, from, to, delay, onStart, onEnd, duration, formatValue]);

  useEffect(() => {
    const unsubscribe = springValue.on('change', (latest: number) => {
      if (settled.current) return;
      if (ref.current) {
        ref.current.textContent = formatValue(latest);
      }
    });

    return () => unsubscribe();
  }, [springValue, formatValue]);

  return <span className={className} ref={ref} />;
}

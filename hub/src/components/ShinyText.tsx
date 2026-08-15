import React, { useState, useCallback, useEffect, useRef } from 'react';
import { motion, useMotionValue, useAnimationFrame, useTransform } from 'motion/react';

interface ShinyTextProps {
  text: string;
  disabled?: boolean;
  speed?: number;
  className?: string;
  color?: string;
  shineColor?: string;
  spread?: number;
  yoyo?: boolean;
  pauseOnHover?: boolean;
  direction?: 'left' | 'right';
  delay?: number;
  /**
   * WILDCAT CHANGE. How many times the shine crosses the text before the
   * component settles and STOPS. Default Infinity is the published behaviour.
   *
   * As published this component runs `useAnimationFrame` for the life of the
   * page: the shine never ends, and `delay` is a hold at the END of each lap
   * rather than a lead-in, so it loops forever whatever you pass it. On the
   * sign-in screen — the one screen every student loads every morning, on a
   * Chromebook, while waiting for Google — that is a frame callback and a
   * repaint of the subtitle sixty times a second, indefinitely, for decoration.
   *
   * `cycles={1}` makes the "one pass" the call site always claimed. The driver
   * lives in a child component so that finishing UNMOUNTS the hook: an early
   * `return` inside useAnimationFrame would leave motion's frame loop calling
   * it every frame regardless.
   */
  cycles?: number;
  /** WILDCAT CHANGE. Seconds to wait before the first pass starts. */
  startDelay?: number;
}

type Progress = ReturnType<typeof useMotionValue<number>>;

/**
 * WILDCAT CHANGE. The rAF half of ShinyText, extracted so it can be unmounted.
 * Renders nothing; it exists only to drive `progress`.
 */
const ShineDriver: React.FC<{
  progress: Progress;
  isPaused: boolean;
  speed: number;
  delay: number;
  startDelay: number;
  yoyo: boolean;
  direction: 'left' | 'right';
  cycles: number;
  onSettled: () => void;
}> = ({ progress, isPaused, speed, delay, startDelay, yoyo, direction, cycles, onSettled }) => {
  const elapsedRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const directionRef = useRef(direction === 'left' ? 1 : -1);
  const settledRef = useRef(false);

  const animationDuration = speed * 1000;
  const delayDuration = delay * 1000;
  const leadIn = startDelay * 1000;

  useEffect(() => {
    directionRef.current = direction === 'left' ? 1 : -1;
    elapsedRef.current = 0;
    progress.set(direction === 'left' ? 0 : 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction]);

  useAnimationFrame(time => {
    if (isPaused) {
      lastTimeRef.current = null;
      return;
    }

    if (lastTimeRef.current === null) {
      lastTimeRef.current = time;
      return;
    }

    const deltaTime = time - lastTimeRef.current;
    lastTimeRef.current = time;

    elapsedRef.current += deltaTime;

    // WILDCAT CHANGE: a real lead-in. Hold at the start until it has passed, so
    // the shine can be timed to arrive after the wordmark has landed.
    if (elapsedRef.current < leadIn) {
      progress.set(directionRef.current === 1 ? 0 : 100);
      return;
    }
    const elapsed = elapsedRef.current - leadIn;

    // WILDCAT CHANGE: stop after `cycles` laps and tell the parent, which then
    // unmounts this driver and with it the frame callback. The trailing hold
    // (`delay`) is not waited out — there is nothing after it to wait for.
    if (Number.isFinite(cycles)) {
      const lap = (yoyo ? 2 : 1) * (animationDuration + delayDuration);
      if (elapsed >= cycles * lap - delayDuration) {
        progress.set(directionRef.current === 1 ? 100 : 0);
        if (!settledRef.current) {
          settledRef.current = true;
          onSettled();
        }
        return;
      }
    }

    // Animation goes from 0 to 100
    if (yoyo) {
      const cycleDuration = animationDuration + delayDuration;
      const fullCycle = cycleDuration * 2;
      const cycleTime = elapsed % fullCycle;

      if (cycleTime < animationDuration) {
        // Forward animation: 0 -> 100
        const p = (cycleTime / animationDuration) * 100;
        progress.set(directionRef.current === 1 ? p : 100 - p);
      } else if (cycleTime < cycleDuration) {
        // Delay at end
        progress.set(directionRef.current === 1 ? 100 : 0);
      } else if (cycleTime < cycleDuration + animationDuration) {
        // Reverse animation: 100 -> 0
        const reverseTime = cycleTime - cycleDuration;
        const p = 100 - (reverseTime / animationDuration) * 100;
        progress.set(directionRef.current === 1 ? p : 100 - p);
      } else {
        // Delay at start
        progress.set(directionRef.current === 1 ? 0 : 100);
      }
    } else {
      const cycleDuration = animationDuration + delayDuration;
      const cycleTime = elapsed % cycleDuration;

      if (cycleTime < animationDuration) {
        // Animation phase: 0 -> 100
        const p = (cycleTime / animationDuration) * 100;
        progress.set(directionRef.current === 1 ? p : 100 - p);
      } else {
        // Delay phase - hold at end (shine off-screen)
        progress.set(directionRef.current === 1 ? 100 : 0);
      }
    }
  });

  return null;
};

const ShinyText: React.FC<ShinyTextProps> = ({
  text,
  disabled = false,
  speed = 2,
  className = '',
  color = '#b5b5b5',
  shineColor = '#ffffff',
  spread = 120,
  yoyo = false,
  pauseOnHover = false,
  direction = 'left',
  delay = 0,
  cycles = Infinity,
  startDelay = 0
}) => {
  const [isPaused, setIsPaused] = useState(false);
  const [settled, setSettled] = useState(false);
  const progress = useMotionValue(direction === 'left' ? 0 : 100);

  const handleSettled = useCallback(() => setSettled(true), []);

  // Transform: p=0 -> 150% (shine off right), p=100 -> -50% (shine off left)
  const backgroundPosition = useTransform(progress, p => `${150 - p * 2}% center`);

  const handleMouseEnter = useCallback(() => {
    if (pauseOnHover) setIsPaused(true);
  }, [pauseOnHover]);

  const handleMouseLeave = useCallback(() => {
    if (pauseOnHover) setIsPaused(false);
  }, [pauseOnHover]);

  const gradientStyle: React.CSSProperties = {
    backgroundImage: `linear-gradient(${spread}deg, ${color} 0%, ${color} 35%, ${shineColor} 50%, ${color} 65%, ${color} 100%)`,
    backgroundSize: '200% auto',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent'
  };

  return (
    <motion.span
      className={`inline-block ${className}`}
      style={{ ...gradientStyle, backgroundPosition }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {text}
      {!disabled && !settled && cycles > 0 && (
        <ShineDriver
          progress={progress}
          isPaused={isPaused}
          speed={speed}
          delay={delay}
          startDelay={startDelay}
          yoyo={yoyo}
          direction={direction}
          cycles={cycles}
          onSettled={handleSettled}
        />
      )}
    </motion.span>
  );
};

export default ShinyText;

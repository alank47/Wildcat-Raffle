import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
  type MouseEventHandler,
  type UIEvent
} from 'react';
import { motion, useInView } from 'motion/react';

interface AnimatedItemProps {
  children: ReactNode;
  delay?: number;
  index: number;
  reduceMotion?: boolean;
  interactive?: boolean;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onClick?: MouseEventHandler<HTMLDivElement>;
}

/**
 * WILDCAT CHANGES, all four for the same reason — this list holds a student's
 * timetable and their grades, and it is read several times a day on a
 * Chromebook:
 *
 *   once: true          was `once: false`, so every row re-ran its entrance
 *                       each time it scrolled past. Reveal-on-load is wanted;
 *                       reveal-on-every-scroll is a distraction with a cost.
 *   amount: 0.2         was 0.5. Half a row had to be visible before it would
 *                       appear, so the row you were scrolling toward was blank.
 *   scale 0.98          was 0.7. rb-standards: nothing appears from nothing,
 *                       start at 0.9-0.97; 0.7 on a text row reads as a zoom.
 *   duration 0.22       inside the <300ms UI band, with a real stagger instead
 *                       of every row sharing one 0.1s delay.
 *   cursor-pointer      only when the row actually does something on click.
 */
const AnimatedItem: React.FC<AnimatedItemProps> = ({
  children,
  delay = 0,
  index,
  reduceMotion = false,
  interactive = false,
  onMouseEnter,
  onClick
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2, once: true });
  const hidden = reduceMotion ? { opacity: 0 } : { scale: 0.98, opacity: 0, y: 8 };
  const shown = reduceMotion ? { opacity: 1 } : { scale: 1, opacity: 1, y: 0 };
  return (
    <motion.div
      ref={ref}
      data-index={index}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      initial={hidden}
      animate={inView ? shown : hidden}
      transition={{ duration: reduceMotion ? 0.15 : 0.22, delay, ease: [0.23, 1, 0.32, 1] }}
      className={interactive ? 'cursor-pointer' : ''}
    >
      {children}
    </motion.div>
  );
};

interface AnimatedListProps {
  /**
   * WILDCAT CHANGE: ReactNode, not string. A timetable row is a course, a
   * period, a teacher and a term; a grade row is a course and a letter and a
   * percent that must be able to render as "not graded yet" rather than as 0.
   * None of that survives being flattened to one string, and the alternative
   * was a second list component that would drift from this one.
   */
  items?: ReactNode[];
  onItemSelect?: (item: ReactNode, index: number) => void;
  showGradients?: boolean;
  enableArrowNavigation?: boolean;
  className?: string;
  itemClassName?: string;
  displayScrollbar?: boolean;
  initialSelectedIndex?: number;
  /** Movement off, opacity kept. See lib/motion.ts. */
  reduceMotion?: boolean;
  /** ms between row entrances. rb-standards: 30-80ms. */
  staggerMs?: number;
  /** Ground colour the top/bottom scroll fades blend into. */
  fadeColor?: string;
  /** Rows only get a pointer cursor when clicking them does something. */
  interactive?: boolean;
}

const AnimatedList: React.FC<AnimatedListProps> = ({
  items = [],
  onItemSelect,
  showGradients = true,
  /**
   * WILDCAT CHANGE: default false. This handler calls preventDefault() on Tab
   * at the WINDOW, so mounting one of these anywhere on a page takes the Tab
   * key away from every other control on it. On a school Chromebook, where
   * keyboard navigation is how a lot of students move, that is a defect. Opt in
   * where the list really is the page's only focus target.
   */
  enableArrowNavigation = false,
  className = '',
  itemClassName = '',
  displayScrollbar = true,
  initialSelectedIndex = -1,
  reduceMotion = false,
  staggerMs = 45,
  fadeColor = '#0B0B0E',
  interactive = false
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(initialSelectedIndex);
  const [keyboardNav, setKeyboardNav] = useState<boolean>(false);
  const [topGradientOpacity, setTopGradientOpacity] = useState<number>(0);
  const [bottomGradientOpacity, setBottomGradientOpacity] = useState<number>(1);

  const handleItemMouseEnter = useCallback((index: number) => {
    setSelectedIndex(index);
  }, []);

  const handleItemClick = useCallback(
    (item: ReactNode, index: number) => {
      setSelectedIndex(index);
      if (onItemSelect) {
        onItemSelect(item, index);
      }
    },
    [onItemSelect]
  );

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target as HTMLDivElement;
    setTopGradientOpacity(Math.min(scrollTop / 50, 1));
    const bottomDistance = scrollHeight - (scrollTop + clientHeight);
    setBottomGradientOpacity(scrollHeight <= clientHeight ? 0 : Math.min(bottomDistance / 50, 1));
  };

  useEffect(() => {
    if (!enableArrowNavigation) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        setKeyboardNav(true);
        setSelectedIndex(prev => Math.min(prev + 1, items.length - 1));
      } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        setKeyboardNav(true);
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        if (selectedIndex >= 0 && selectedIndex < items.length) {
          e.preventDefault();
          if (onItemSelect) {
            onItemSelect(items[selectedIndex], selectedIndex);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, selectedIndex, onItemSelect, enableArrowNavigation]);

  useEffect(() => {
    if (!keyboardNav || selectedIndex < 0 || !listRef.current) return;
    const container = listRef.current;
    const selectedItem = container.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement | null;
    if (selectedItem) {
      const extraMargin = 50;
      const containerScrollTop = container.scrollTop;
      const containerHeight = container.clientHeight;
      const itemTop = selectedItem.offsetTop;
      const itemBottom = itemTop + selectedItem.offsetHeight;
      if (itemTop < containerScrollTop + extraMargin) {
        container.scrollTo({ top: itemTop - extraMargin, behavior: 'smooth' });
      } else if (itemBottom > containerScrollTop + containerHeight - extraMargin) {
        container.scrollTo({
          top: itemBottom - containerHeight + extraMargin,
          behavior: 'smooth'
        });
      }
    }
    setKeyboardNav(false);
  }, [selectedIndex, keyboardNav]);

  return (
    <div className={`relative w-full ${className}`}>
      <div
        ref={listRef}
        className={`overflow-y-auto ${displayScrollbar ? 'wc-scroll' : 'scrollbar-hide'}`}
        onScroll={handleScroll}
        style={{
          scrollbarWidth: displayScrollbar ? 'thin' : 'none',
          scrollbarColor: 'rgba(255,255,255,0.14) transparent'
        }}
      >
        {items.map((item, index) => (
          <AnimatedItem
            key={index}
            /* Real stagger, capped. Twelve rows at 45ms is 540ms to the last
               one, which is already at the edge of what reads as instant; past
               that the list feels slow rather than choreographed. */
            delay={reduceMotion ? 0 : Math.min(index * staggerMs, 360) / 1000}
            index={index}
            reduceMotion={reduceMotion}
            interactive={interactive}
            onMouseEnter={interactive ? () => handleItemMouseEnter(index) : undefined}
            onClick={interactive ? () => handleItemClick(item, index) : undefined}
          >
            <div className={itemClassName} data-selected={selectedIndex === index}>
              {typeof item === 'string' ? <p>{item}</p> : item}
            </div>
          </AnimatedItem>
        ))}
      </div>
      {showGradients && (
        <>
          <div
            className="absolute top-0 left-0 right-0 h-[28px] pointer-events-none transition-opacity duration-200 ease-out"
            style={{
              opacity: topGradientOpacity,
              background: `linear-gradient(to bottom, ${fadeColor}, transparent)`
            }}
          ></div>
          <div
            className="absolute bottom-0 left-0 right-0 h-[40px] pointer-events-none transition-opacity duration-200 ease-out"
            style={{
              opacity: bottomGradientOpacity,
              background: `linear-gradient(to top, ${fadeColor}, transparent)`
            }}
          ></div>
        </>
      )}
    </div>
  );
};

export default AnimatedList;

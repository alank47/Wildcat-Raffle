import React, { useState, Children, useRef, useLayoutEffect, type HTMLAttributes, type ReactNode } from 'react';
import { motion, AnimatePresence, type Variants } from 'motion/react';

interface StepperProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  initialStep?: number;
  onStepChange?: (step: number) => void;
  onFinalStepCompleted?: () => void;
  stepCircleContainerClassName?: string;
  stepContainerClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
  backButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  nextButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  backButtonText?: string;
  nextButtonText?: string;
  disableStepIndicators?: boolean;
  renderStepIndicator?: (props: {
    step: number;
    currentStep: number;
    onStepClick: (clicked: number) => void;
  }) => ReactNode;
}

export default function Stepper({
  children,
  initialStep = 1,
  onStepChange = () => {},
  onFinalStepCompleted = () => {},
  stepCircleContainerClassName = '',
  stepContainerClassName = '',
  contentClassName = '',
  footerClassName = '',
  backButtonProps = {},
  nextButtonProps = {},
  backButtonText = 'Back',
  nextButtonText = 'Continue',
  disableStepIndicators = false,
  renderStepIndicator,
  ...rest
}: StepperProps) {
  const [currentStep, setCurrentStep] = useState<number>(initialStep);
  const [direction, setDirection] = useState<number>(0);
  const stepsArray = Children.toArray(children);
  const totalSteps = stepsArray.length;
  const isCompleted = currentStep > totalSteps;
  const isLastStep = currentStep === totalSteps;

  const updateStep = (newStep: number) => {
    setCurrentStep(newStep);
    if (newStep > totalSteps) {
      onFinalStepCompleted();
    } else {
      onStepChange(newStep);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setDirection(-1);
      updateStep(currentStep - 1);
    }
  };

  const handleNext = () => {
    if (!isLastStep) {
      setDirection(1);
      updateStep(currentStep + 1);
    }
  };

  const handleComplete = () => {
    setDirection(1);
    updateStep(totalSteps + 1);
  };

  return (
    <div
      className="flex min-h-full flex-1 flex-col items-center justify-center p-4 sm:aspect-[4/3] md:aspect-[2/1]"
      {...rest}
    >
      <div
        className={`mx-auto w-full max-w-md rounded-4xl shadow-xl ${stepCircleContainerClassName}`}
        style={{ border: '1px solid #222' }}
      >
        <div className={`${stepContainerClassName} flex w-full items-center p-8`}>
          {stepsArray.map((_, index) => {
            const stepNumber = index + 1;
            const isNotLastStep = index < totalSteps - 1;
            return (
              <React.Fragment key={stepNumber}>
                {renderStepIndicator ? (
                  renderStepIndicator({
                    step: stepNumber,
                    currentStep,
                    onStepClick: clicked => {
                      setDirection(clicked > currentStep ? 1 : -1);
                      updateStep(clicked);
                    }
                  })
                ) : (
                  <StepIndicator
                    step={stepNumber}
                    disableStepIndicators={disableStepIndicators}
                    currentStep={currentStep}
                    onClickStep={clicked => {
                      setDirection(clicked > currentStep ? 1 : -1);
                      updateStep(clicked);
                    }}
                  />
                )}
                {isNotLastStep && <StepConnector isComplete={currentStep > stepNumber} />}
              </React.Fragment>
            );
          })}
        </div>

        <StepContentWrapper
          isCompleted={isCompleted}
          currentStep={currentStep}
          direction={direction}
          className={`space-y-2 px-8 ${contentClassName}`}
        >
          {stepsArray[currentStep - 1]}
        </StepContentWrapper>

        {!isCompleted && (
          <div className={`px-8 pb-8 ${footerClassName}`}>
            <div className={`mt-10 flex ${currentStep !== 1 ? 'justify-between' : 'justify-end'}`}>
              {currentStep !== 1 && (
                /* WILDCAT CHANGE: the `hover:` variants are gone from both
                   default buttons, along with React Bits' green.

                   Both are overridden by backButtonProps / nextButtonProps at
                   the only call site, so nothing on screen changes. What
                   changes is the compiled stylesheet: Tailwind emitted
                   `.hover\:bg-green-600:hover` and `.hover\:text-neutral-700:hover`
                   into a bare `@media (hover: hover)` block, which is one test,
                   not two. `hover: hover` is true of a stylus and of a hybrid
                   laptop with a touchscreen; `pointer: fine` is what separates
                   a trackpad from a fingertip. Every hover rule in this app now
                   lives behind BOTH tests in index.css and there are no others
                   left in the bundle — which is a property you can grep for,
                   and a defaulted-in green hover would have quietly broken it. */
                <button
                  onClick={handleBack}
                  className={`duration-350 rounded px-2 py-1 transition ${
                    currentStep === 1
                      ? 'pointer-events-none opacity-50 text-neutral-400'
                      : 'text-neutral-400'
                  }`}
                  {...backButtonProps}
                >
                  {backButtonText}
                </button>
              )}
              <button
                onClick={isLastStep ? handleComplete : handleNext}
                className="duration-350 flex items-center justify-center rounded-full bg-wc-blue py-1.5 px-3.5 font-medium tracking-tight text-white transition"
                {...nextButtonProps}
              >
                {isLastStep ? 'Complete' : nextButtonText}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface StepContentWrapperProps {
  isCompleted: boolean;
  currentStep: number;
  direction: number;
  children: ReactNode;
  className?: string;
}

function StepContentWrapper({
  isCompleted,
  currentStep,
  direction,
  children,
  className = ''
}: StepContentWrapperProps) {
  const [parentHeight, setParentHeight] = useState<number>(0);

  /**
   * WILDCAT CHANGE: `auto` until the first measurement.
   *
   * As published this starts at `height: 0` and springs open to the height
   * measured in a layout effect — so the first paint of the hall-pass form is a
   * collapsed strip that then unfolds, every single time the screen is opened.
   * It is also the one animation in the app that animates HEIGHT, which
   * rb-standards puts on the never list because it costs layout, and it was
   * paying that cost to produce a flash.
   *
   * With `auto` on the first render there is nothing to animate to: the layout
   * effect measures before paint and the number it writes is the height the box
   * already has. Every LATER change — step two being taller than step one — is
   * still a real measured transition, which is what the spring was for.
   */
  const height = isCompleted ? 0 : parentHeight === 0 ? 'auto' : parentHeight;

  return (
    <motion.div
      style={{ position: 'relative', overflow: 'hidden' }}
      animate={{ height }}
      transition={{ type: 'spring', duration: 0.4 }}
      className={className}
    >
      <AnimatePresence initial={false} mode="sync" custom={direction}>
        {!isCompleted && (
          <SlideTransition key={currentStep} direction={direction} onHeightReady={h => setParentHeight(h)}>
            {children}
          </SlideTransition>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

interface SlideTransitionProps {
  children: ReactNode;
  direction: number;
  onHeightReady: (height: number) => void;
}

function SlideTransition({ children, direction, onHeightReady }: SlideTransitionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (containerRef.current) {
      onHeightReady(containerRef.current.offsetHeight);
    }
  }, [children, onHeightReady]);

  return (
    <motion.div
      ref={containerRef}
      custom={direction}
      variants={stepVariants}
      initial="enter"
      animate="center"
      exit="exit"
      /* 240ms, not 400. This is a pane swap between two steps of a form, which
         rb-standards puts in the same band as a dropdown; 400ms of slide is felt
         as the form being slow rather than as the form being animated. */
      transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
      style={{ position: 'absolute', left: 0, right: 0, top: 0 }}
    >
      {children}
    </motion.div>
  );
}

/**
 * WILDCAT CHANGE: the direction was inverted.
 *
 * As published, going FORWARD (dir = 1) brought the new step in from `-100%`,
 * i.e. from the left, while the old step left to `+50%`, i.e. to the right — so
 * pressing "Next" moved the form backwards and the two panels crossed through
 * each other. rb-standards calls this spatial consistency, and it is the one
 * thing a slide transition is for: on a three-step form the animation is the
 * only thing telling a student whether they just advanced or just went back.
 *
 * Forward: the new step arrives from the right, the old one leaves to the left.
 */
const stepVariants: Variants = {
  enter: (dir: number) => ({
    x: dir >= 0 ? '100%' : '-100%',
    opacity: 0
  }),
  center: {
    x: '0%',
    opacity: 1
  },
  exit: (dir: number) => ({
    x: dir >= 0 ? '-50%' : '50%',
    opacity: 0
  })
};

interface StepProps {
  children: ReactNode;
  className?: string;
}

/**
 * WILDCAT CHANGE: the gutter is a prop.
 *
 * It has to live here and nowhere else. The wrapper that `contentClassName`
 * styles is `position: relative` and each step inside it is `position: absolute;
 * left: 0; right: 0` — an absolutely positioned box is laid out against its
 * containing block's PADDING BOX, so padding on that wrapper moves nothing.
 * Padding set through contentClassName is silently ignored, which is exactly the
 * kind of thing that looks like a Tailwind specificity problem for an hour. So
 * the step owns its own gutter, and the caller can set it.
 */
export function Step({ children, className = 'px-8' }: StepProps) {
  return <div className={className}>{children}</div>;
}

interface StepIndicatorProps {
  step: number;
  currentStep: number;
  onClickStep: (clicked: number) => void;
  disableStepIndicators?: boolean;
}

function StepIndicator({ step, currentStep, onClickStep, disableStepIndicators = false }: StepIndicatorProps) {
  const status = currentStep === step ? 'active' : currentStep < step ? 'inactive' : 'complete';

  const handleClick = () => {
    if (step !== currentStep && !disableStepIndicators) {
      onClickStep(step);
    }
  };

  return (
    <motion.div
      onClick={handleClick}
      className={`relative outline-none focus:outline-none ${disableStepIndicators ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}
      animate={status}
      initial={false}
    >
      <motion.div
        /* WILDCAT CHANGE: #5227FF is React Bits' violet. This branch of the
           component is only reached when a caller does NOT pass
           renderStepIndicator — the hall pass screen does — but a default that
           paints a purple circle into a school app is a trap left lying in the
           source for whoever adds the second Stepper. School blue, and the
           complete state stops being a different blue from the active one. */
        variants={{
          inactive: { scale: 1, backgroundColor: '#222', color: '#a3a3a3' },
          active: { scale: 1, backgroundColor: '#2F67A7', color: '#2F67A7' },
          complete: { scale: 1, backgroundColor: '#2F67A7', color: '#B5D4F4' }
        }}
        transition={{ duration: 0.3 }}
        className="flex h-8 w-8 items-center justify-center rounded-full font-semibold"
      >
        {status === 'complete' ? (
          <CheckIcon className="h-4 w-4 text-black" />
        ) : status === 'active' ? (
          <div className="h-3 w-3 rounded-full bg-[#120F17]" />
        ) : (
          <span className="text-sm">{step}</span>
        )}
      </motion.div>
    </motion.div>
  );
}

interface StepConnectorProps {
  isComplete: boolean;
}

function StepConnector({ isComplete }: StepConnectorProps) {
  /* WILDCAT CHANGE, twice over.
     1. #5227FF is React Bits' violet and neutral-600 is its grey.
        renderStepIndicator lets a caller replace the circles but not this line,
        so the one unthemeable part of the component would have shipped a purple
        bar into a blue school app. School blue on a hairline track.
     2. It animated `width`, which is the one property rb-standards names
        outright: width triggers layout, paint and composite on every frame, and
        it does it inside a flex row whose siblings then reflow with it. A
        scaleX from a left origin is the same picture on the compositor alone. */
  const lineVariants: Variants = {
    incomplete: { scaleX: 0 },
    complete: { scaleX: 1 }
  };

  return (
    <div className="relative mx-2 h-0.5 flex-1 overflow-hidden rounded bg-white/10">
      <motion.div
        className="absolute left-0 top-0 h-full w-full origin-left bg-wc-blue"
        variants={lineVariants}
        initial={false}
        animate={isComplete ? 'complete' : 'incomplete'}
        transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
      />
    </div>
  );
}

interface CheckIconProps extends React.SVGProps<SVGSVGElement> {}

function CheckIcon(props: CheckIconProps) {
  return (
    <svg {...props} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <motion.path
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{
          delay: 0.1,
          type: 'tween',
          ease: 'easeOut',
          duration: 0.3
        }}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}

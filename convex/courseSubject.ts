/**
 * Guessing a course's subject from its name, and admitting that it is a guess.
 *
 * Pure and dependency-free so a plain-node test reaches it, for the same reason
 * academicsRules.ts, views.ts and accessRules.ts are.
 *
 * WHY THIS FILE EXISTS AT ALL. PowerSchool already knows every course's subject:
 * it is `Courses.Credit_Type`, one column, and it is authoritative. This
 * integration has NOT been granted that column, and asking the district for it
 * is a weeks-long conversation. The school owner asked, on 2026-09-10, to "do
 * your best to assign a course type based on course name" in the meantime.
 *
 * So this is a STOPGAP WEARING ITS OWN LABEL. Every subject it produces is
 * inferred from a string a human typed into a scheduling screen, and the screen
 * that shows a subject rollup has to say so. The day Credit_Type is granted,
 * this file is deleted rather than corrected.
 *
 * THE FAILURE MODE THAT MATTERS. A course filed under the WRONG subject is far
 * worse than one filed under none, because the rollup is what a principal acts
 * on: "math is failing 60% of students" starts a hiring conversation, and it
 * must not be an artifact of "Business Math" and "Math Support Lab" landing in
 * the same bucket as Algebra. So:
 *
 *   - exclusions run BEFORE positive matches, because the words overlap
 *     ("Physical Science" is not PE, "Computer Science" is not Science,
 *     "Social Science" is not Science);
 *   - a name nothing matches becomes UNCLASSIFIED and is DISPLAYED as such,
 *     never quietly dropped and never swept into a nearest neighbour;
 *   - matching is on WHOLE WORDS, not substrings, because "ART" is inside
 *     "EARTH SCIENCE" and "PE" is inside "SPEECH".
 */

/** The taxonomy. California secondary, roughly A-G shaped. */
export const SUBJECTS = [
  "English",
  "Mathematics",
  "Science",
  "Social Studies",
  "World Languages",
  "Visual & Performing Arts",
  "Physical Education & Health",
  "Career & Technical",
  "Support & Advisory",
] as const;

export type Subject = (typeof SUBJECTS)[number] | "Not categorised";

export const UNCLASSIFIED: Subject = "Not categorised";

/**
 * Fold a course name into a comparable form.
 *
 * Punctuation becomes a space, so "P.E." and "PE" are the same token, and the
 * result is padded with spaces at both ends so a whole-word test is a plain
 * substring test on " WORD ".
 *
 * THE SEMESTER AND GRADE MARKERS ARE LEFT ALONE ON PURPOSE. "Algebra 1A",
 * "Algebra 1B" and "US History 8A" all keep their tails, and whole-word
 * matching steps over them: " ALGEBRA " is present in " ALGEBRA 1A " either
 * way. Stripping them would be a second place to get a name wrong for no gain.
 */
export function normalise(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const flat = s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // strip accents left by NFD
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return ` ${flat} `;
}

/**
 * A SPECIAL-EDUCATION SECTION, WHICH THIS APP WILL NOT RATE.
 *
 * "RSP A" is a real course at this school (docs/sis-expansion.md:190, two
 * sections, 20 students). It is above the SMALL_GROUP floor, so nothing else
 * here would stop a failure rate for it reaching the screen -- and that rate
 * would be a statement about students with disabilities, which is a protected
 * characteristic this app has no approval to report on.
 *
 * The approval record refuses the analogous case explicitly: English-learner
 * status is "NOT approved. No decision has been named that it informs."
 * (docs/field-sourcing-approval.md). Disability status was never even asked
 * for. A course-level rate is an aggregate, but when the roster of the course
 * IS the protected group, the aggregate is the disclosure.
 *
 * So these sections are dropped from the ranking and from the subject rollup,
 * and the screen says how many were dropped rather than silently shrinking.
 * They still count in the school-wide totals, where they identify nobody.
 */
export function isSpecialEducation(courseName: unknown): boolean {
  const n = normalise(courseName);
  // RESOURCE is guarded, because "Natural Resources" and "Human Resources" are
  // ordinary CTE courses and flagging one as special education would be a
  // disability label attached to a child by a substring.
  if (has(n, "NATURAL RESOURCES", "HUMAN RESOURCES", "RESOURCE MANAGEMENT")) return false;
  // LIFE SKILLS is deliberately NOT here. It is a general elective at many
  // schools, and a disability marker is not something to guess at.
  return has(n, "RSP", "SDC", "SAI", "SPECIAL ED", "SPECIAL EDUCATION",
                "SPECIAL DAY", "RESOURCE", "RESOURCE SPECIALIST",
                "RESOURCE ROOM", "SPED", "IEP", "ADAPTED PE", "ADAPTIVE PE");
}

/**
 * AN ENGLISH-LEARNER PROGRAMME SECTION, WHICH IS REFUSED FOR THE SAME REASON.
 *
 * ELD, ESL and newcomer sections are not a subject -- they are a PROGRAMME, and
 * the roster of one is the school's English-learner population. Rating such a
 * course publishes an outcome for English learners under a course heading.
 *
 * The approval record refuses this by name, not by analogy:
 * docs/field-sourcing-approval.md carries English-learner status as "NOT
 * approved. No decision has been named that it informs." A rate over a course
 * whose roster IS that cohort is that same reporting wearing a course label,
 * and routing around a refusal by relabelling it would be worse than reporting
 * it openly.
 *
 * The subject is still English -- an ELD class teaches English. This is a
 * separate axis, exactly as it is for a resource English section.
 */
export function isEnglishLearnerProgram(courseName: unknown): boolean {
  const n = normalise(courseName);
  return has(n, "ELD", "ESL", "ENGLISH LANGUAGE DEVELOPMENT", "NEWCOMER",
                "NEWCOMERS", "ENGLISH LEARNER", "ENGLISH LEARNERS",
                "SHELTERED", "SDAIE", "ELL");
}

/**
 * Courses this app will not put a failure rate on, whatever their subject.
 *
 * Both members are here for ONE reason: the roster of the course is itself a
 * protected group, so an aggregate over the course is the disclosure. Nothing
 * else belongs in this function -- a course being small, unpopular or badly
 * named is not a reason to hide it, and the SMALL_GROUP floor already handles
 * size.
 *
 * These courses are NOT dropped from the school-wide totals. A student in an
 * ELD or resource section still counts in "students with a D or F" and in the
 * depth distribution, where they identify nobody. Only the per-course row and
 * the subject rollup exclude them, and the screen says how many were left out.
 */
/**
 * A HERITAGE-LANGUAGE SECTION, refused on the same principle.
 *
 * "Spanish for Spanish Speakers" is a real and common California course, and
 * the thing that puts a student in it is the language spoken at home -- which
 * is a proxy for national origin. The roster is the cohort, so a rate over the
 * course is a rate over the cohort.
 */
export function isHeritageLanguageSection(courseName: unknown): boolean {
  const n = normalise(courseName);
  return has(n, "SPANISH SPEAKERS", "HERITAGE SPEAKERS", "NATIVE SPEAKERS",
                "HERITAGE SPANISH", "FOR SPANISH SPEAKERS");
}

/**
 * A COURSE WITH NO NAME AT ALL, which this app also refuses to rate.
 *
 * FOUND IN THE LIVE CATALOGUE ON 2026-09-10 AND IT IS THE CASE THAT MATTERS.
 * Course 7002A carries no `courseName`: the grades PowerQuery LEFT JOINs
 * COURSES, so a missing course row blanks the name rather than dropping the
 * child's row. That course is "RSP A" (docs/sis-expansion.md:190) -- a
 * special-education section of about twenty students.
 *
 * Every other refusal here works by READING the name. With no name, all of
 * them return false, and a special-education section would have sailed
 * through every guard and published a failure rate under the label
 * "Course 7002A".
 *
 * So the rule is the conservative one: a course we cannot name is a course we
 * cannot clear. It is listed in the catalogue count and left out of the
 * ranking, and its students still count in every school-wide figure.
 */
export function isUnnamedCourse(courseName: unknown): boolean {
  return normalise(courseName).trim() === "";
}

export function isUnratedCohort(courseName: unknown): boolean {
  return isUnnamedCourse(courseName) ||
    isSpecialEducation(courseName) ||
    isEnglishLearnerProgram(courseName) ||
    isHeritageLanguageSection(courseName);
}

/** Does the normalised name contain this whole word (or whole phrase)? */
function has(padded: string, ...words: string[]): boolean {
  return words.some((w) => padded.includes(` ${w} `));
}

/**
 * THE RULES, IN ORDER. The first match wins, and THE ORDER IS THE DESIGN.
 *
 * Almost every entry in the exclusion block exists because a positive rule
 * further down gets that name WRONG. The first draft of this file had the
 * blocks in the wrong order and quietly returned: "Culinary Arts" as Visual &
 * Performing Arts, "Art History" as Social Studies, "Health Science" as
 * Science, "Home Economics" as Social Studies, "Student Government" as Social
 * Studies, "Latin American Studies" as a world language and "Reading
 * Intervention" as English. None of those threw. All of them would have shown
 * up as a confident subject label on a principal's screen.
 *
 * DO NOT REORDER WITHOUT READING THE NOTES. A note is the reason the rule is
 * where it is.
 */
type Rule = { subject: Subject; test: (n: string) => boolean; note?: string };

/** ARTS is inside LANGUAGE ARTS; ART is inside MARTIAL ARTS. Word-safe, span-safe. */
const RULES: Rule[] = [
  // ==== BLOCK 1: names carrying a subject word that are NOT that subject ====
  //
  // Each of these returns before the positive core it would otherwise hit.

  {
    subject: "English",
    note: "LANGUAGE ARTS must precede every ARTS rule: ' ARTS ' really does " +
          "match inside ' LANGUAGE ARTS '.",
    test: (n) => has(n, "LANGUAGE ARTS", "ENGLISH LANGUAGE ARTS"),
  },
  {
    subject: "Physical Education & Health",
    note: "MARTIAL ARTS is not an art form for this purpose; it is a PE elective.",
    test: (n) => has(n, "MARTIAL ARTS", "SELF DEFENSE"),
  },
  {
    subject: "Career & Technical",
    note: "CULINARY ARTS, INDUSTRIAL ARTS and PRACTICAL ARTS are CTE pathways. " +
          "All three contain ARTS and none is a performing art.",
    test: (n) => has(n, "CULINARY ARTS", "CULINARY", "INDUSTRIAL ARTS",
                        "INDUSTRIAL TECHNOLOGY", "PRACTICAL ARTS"),
  },
  {
    subject: "Visual & Performing Arts",
    note: "MEDIA / DIGITAL / GRAPHIC ARTS are arts, and must be claimed here " +
          "before the CTE rule below sweeps up anything technical-sounding.",
    test: (n) => has(n, "MEDIA ARTS", "DIGITAL ARTS", "GRAPHIC ARTS"),
  },
  {
    subject: "Visual & Performing Arts",
    note: "ART HISTORY and MUSIC HISTORY must precede HISTORY, or they file as " +
          "Social Studies.",
    test: (n) => has(n, "ART HISTORY", "MUSIC HISTORY", "HISTORY OF ART",
                        "HISTORY OF MUSIC"),
  },
  {
    subject: "Social Studies",
    note: "LATIN AMERICAN must precede LATIN, or a history course becomes a " +
          "world language.",
    test: (n) => has(n, "LATIN AMERICAN", "LATIN AMERICAN STUDIES",
                        "LATIN AMERICAN HISTORY"),
  },
  {
    subject: "Science",
    note: "PHYSICAL SCIENCE before PHYSICAL EDUCATION. There is deliberately no " +
          "bare PHYSICAL rule anywhere in this table, which is what makes this " +
          "safe rather than merely lucky.",
    test: (n) => has(n, "PHYSICAL SCIENCE", "PHYSICAL SCI"),
  },
  {
    subject: "Social Studies",
    note: "SOCIAL / POLITICAL / BEHAVIORAL SCIENCE are not laboratory science.",
    test: (n) => has(n, "SOCIAL SCIENCE", "SOCIAL SCIENCES", "SOCIAL STUDIES",
                        "POLITICAL SCIENCE", "BEHAVIORAL SCIENCE"),
  },
  {
    subject: "Career & Technical",
    note: "COMPUTER SCIENCE is not Science. Never add a bare IT rule -- it is " +
          "an English word.",
    test: (n) => has(n, "COMPUTER", "COMPUTING", "COMP SCI", "CODING",
                        "PROGRAMMING", "INFORMATION TECHNOLOGY", "CYBERSECURITY",
                        "WEB DESIGN", "GAME DESIGN", "ROBOTICS", "ENGINEERING",
                        "CAD", "DRAFTING", "KEYBOARDING"),
  },
  {
    subject: "Career & Technical",
    note: "The health-careers family must precede BOTH the Science rule (it " +
          "contains SCIENCE) and the PE rule (it contains HEALTH).",
    test: (n) => has(n, "HEALTH SCIENCE", "HEALTH CARE", "HEALTH CAREERS",
                        "HEALTH OCCUPATIONS", "HEALTH PROFESSIONS",
                        "MEDICAL TERMINOLOGY", "SPORTS MEDICINE",
                        "ATHLETIC TRAINING", "KINESIOLOGY", "NURSING",
                        "DENTAL", "PHARMACY"),
  },
  {
    subject: "Career & Technical",
    note: "HOME ECONOMICS must precede ECONOMICS, or a cooking class becomes " +
          "a social science.",
    test: (n) => has(n, "HOME ECONOMICS", "FAMILY AND CONSUMER SCIENCE",
                        "CONSUMER SCIENCE", "FACS", "CHILD DEVELOPMENT"),
  },
  {
    subject: UNCLASSIFIED,
    note: "LIBRARY SCIENCE, MILITARY SCIENCE and JROTC are real courses with " +
          "no honest home in this taxonomy. Saying so beats inventing one.",
    test: (n) => has(n, "LIBRARY SCIENCE", "MILITARY SCIENCE", "DOMESTIC SCIENCE",
                        "JROTC", "ROTC"),
  },
  {
    subject: "Career & Technical",
    note: "The sports-business family must precede the PE rule's SPORTS.",
    test: (n) => has(n, "SPORTS MARKETING", "SPORTS MANAGEMENT",
                        "SPORTS BROADCASTING", "SPORTS NUTRITION"),
  },
  {
    subject: "Social Studies",
    note: "ETHNIC STUDIES before the World Languages block, which would " +
          "otherwise not touch it -- kept here so the studies-family reads " +
          "together.",
    test: (n) => has(n, "ETHNIC STUDIES", "CHICANO STUDIES", "AFRICAN AMERICAN STUDIES"),
  },
  {
    subject: "World Languages",
    note: "RUNS BEFORE ENGLISH so 'Spanish Literature' and 'Spanish for " +
          "Spanish Speakers' cannot fall through to it. LATIN is safe here " +
          "only because LATIN AMERICAN already returned above.",
    test: (n) => has(n, "SPANISH", "FRENCH", "MANDARIN", "CHINESE", "JAPANESE",
                        "KOREAN", "LATIN", "GERMAN", "ITALIAN", "ARABIC",
                        "PORTUGUESE", "VIETNAMESE", "TAGALOG", "HEBREW",
                        "AMERICAN SIGN LANGUAGE", "ASL", "WORLD LANGUAGE",
                        "WORLD LANGUAGES"),
  },

  // ==== BLOCK 2: blocks that are not a course of study ======================
  //
  // THESE DOMINATE RATHER THAN MERELY PRECEDE. Any hit returns with no further
  // scan, so "Promise Time Math Support" can never be counted as Mathematics.
  // That is the one row a principal would act on.

  {
    subject: "Support & Advisory",
    note: "STUDENT GOVERNMENT before GOVERNMENT. This school genuinely has a " +
          "course called 'Government' (41 graded, 29 D/F) and the two differ " +
          "by one word.",
    test: (n) => has(n, "STUDENT GOVERNMENT", "ASSOCIATED STUDENT BODY",
                        "STUDENT COUNCIL", "CLASS COUNCIL", "ASB"),
  },
  {
    subject: "Support & Advisory",
    note: "SUSTAINED SILENT READING and SSR before READING.",
    test: (n) => has(n, "SUSTAINED SILENT READING", "SSR", "SILENT READING"),
  },
  {
    subject: "English",
    note: "READING IN THE CONTENT AREA is genuinely English, and is claimed " +
          "here ahead of the generic support rule below.",
    test: (n) => has(n, "READING IN THE CONTENT AREA", "CONTENT AREA READING"),
  },
  {
    subject: "Support & Advisory",
    note: "PEER TUTORING before TUTORING; a peer tutor is not being tutored.",
    test: (n) => has(n, "PEER TUTORING", "PEER MEDIATION", "PEER COUNSELING",
                        "STUDY HALL", "INDEPENDENT STUDY"),
  },
  {
    subject: "Support & Advisory",
    note: "BRANDED INTERVENTION PROGRAMMES, before the subject they name. " +
          "'Math 180' is a remediation product; counting its failure rate as a " +
          "mathematics fact overstates the maths department with the outcomes " +
          "of the students the programme exists to catch.",
    test: (n) => has(n, "MATH 180", "READ 180", "READ180", "SYSTEM 44",
                        "SYSTEM44", "ACHIEVE 3000", "IREADY", "I READY",
                        "EDGENUITY", "APEX", "ODYSSEYWARE", "CYBER HIGH",
                        "CREDIT RECOVERY"),
  },
  {
    subject: "Support & Advisory",
    note: "A SUPPORT WORD BESIDE A CORE SUBJECT WORD. A support section's " +
          "population is pre-selected for students who already fail, so its " +
          "rate is not a fact about the core course and must never be pooled " +
          "with it.",
    test: (n) =>
      has(n, "SUPPORT", "INTERVENTION", "REMEDIAL", "TUTORIAL", "TUTORING",
              "READINESS", "STRATEGIC", "ESSENTIALS", "BASIC SKILLS",
              "LEARNING CENTER", "ACADEMIC LAB", "ACADEMIC SUPPORT") ||
      (has(n, "LAB") &&
        has(n, "MATH", "READING", "WRITING", "LEARNING", "SKILLS", "ACADEMIC")),
  },
  {
    subject: "Support & Advisory",
    note: "ADVISORY AND NON-INSTRUCTIONAL BLOCKS. 'Promise Time' and 'Power " +
          "Up' are this school's own names, read off a real teacher's roster " +
          "on 2026-08-18 (wildcat-roster.js:58-66). studentProfileRules.ts " +
          "keys on the first of them separately; the two must move together. " +
          "LIFE SKILLS lives here and NOT in the special-education predicate " +
          "-- it is a general elective at many schools, and a disability " +
          "marker is not a thing to guess at.",
    test: (n) => has(n, "PROMISE TIME", "POWER UP", "ADVISORY", "ADVISEMENT",
                        "HOMEROOM", "HOME ROOM", "AVID", "PUENTE", "LINK CREW",
                        "SEMINAR", "MENTORING", "LEADERSHIP", "SERVICE LEARNING",
                        "COMMUNITY SERVICE", "WORK EXPERIENCE",
                        "WORK BASED LEARNING", "INTERNSHIP",
                        "COLLEGE AND CAREER", "COLLEGE CAREER", "OFFICE AIDE",
                        "TEACHER AIDE", "LIBRARY AIDE", "TEACHER ASSISTANT",
                        "STUDENT AIDE", "AIDE", "LIFE SKILLS", "SEL",
                        "SOCIAL EMOTIONAL", "RESTORATIVE", "STUDY SKILLS",
                        // ENRICHMENT is this school's own name for a
                        // non-core block: four sections, read off the live
                        // catalogue on 2026-09-10.
                        "ENRICHMENT"),
  },

  // ==== BLOCK 3: names that genuinely mean two things =======================
  //
  // THE HONEST ANSWER TO A COIN FLIP IS "I DO NOT KNOW". Each of these carries
  // credit in two different subjects at different California schools, and the
  // NAME does not say which this school chose. Filing them silently under the
  // more likely one is how a taxonomy becomes confidently wrong; sending them
  // to the visible residue is how somebody notices and pins them.

  {
    subject: UNCLASSIFIED,
    note: "BUSINESS MATH carries maths credit at some schools and CTE credit " +
          "at others. The tempting 'fix' is to map it to Mathematics so the " +
          "residue row disappears -- and then core maths quietly absorbs an " +
          "elective with a different population.",
    test: (n) => has(n, "BUSINESS MATH", "CONSUMER MATH", "FINANCIAL ALGEBRA"),
  },
  {
    subject: UNCLASSIFIED,
    note: "JOURNALISM and TECHNICAL WRITING commonly carry English credit, and " +
          "commonly do not. Note that 'Newscasting' is NOT here: it is on a " +
          "real roster beside three Multimedia Production sections, which " +
          "settles it for this school.",
    test: (n) => has(n, "JOURNALISM", "TECHNICAL WRITING"),
  },
  {
    subject: UNCLASSIFIED,
    note: "SPORTS STATISTICS is maths or PE depending on who teaches it. " +
          "Before STATISTICS.",
    test: (n) => has(n, "SPORTS STATISTICS", "SPORTS STATS"),
  },
  {
    subject: UNCLASSIFIED,
    note: "GEO ON ITS OWN is a real PowerSchool truncation, undecidable " +
          "between Geometry and Geography. It must NOT fire inside a name " +
          "that already says which -- this school runs 'World History & Geo " +
          "6A' and '7A', and the first version filed both as uncategorised " +
          "on the strength of one abbreviation sitting next to the word that " +
          "resolves it.",
    test: (n) => has(n, "GEO") &&
      !has(n, "HISTORY", "GEOGRAPHY", "GEOMETRY", "WORLD"),
  },
  {
    subject: UNCLASSIFIED,
    note: "ENVIRONMENTAL STUDIES without the word SCIENCE splits between " +
          "Science and Social Studies. 'Environmental Science' stays Science.",
    test: (n) => has(n, "ENVIRONMENTAL") && !has(n, "SCIENCE"),
  },
  {
    subject: UNCLASSIFIED,
    note: "DANCE is a VAPA discipline in California and routinely awards PE " +
          "credit on a master schedule. 'PE Dance' is unambiguous and is " +
          "caught by the PE rule below, because this one requires PE absent.",
    test: (n) => has(n, "DANCE") &&
      !has(n, "PE", "P E", "PHYSICAL EDUCATION", "DANCE FITNESS"),
  },

  // ==== BLOCK 4: the positive cores ========================================
  //
  // Every bare keyword here is safe ONLY because the blocks above have already
  // returned. Bare SCIENCE is safe because every "X SCIENCE" trap left; bare
  // GOVERNMENT because STUDENT GOVERNMENT left; bare ART because LANGUAGE,
  // MARTIAL, CULINARY and INDUSTRIAL ARTS left.

  {
    subject: "Mathematics",
    test: (n) => has(n, "MATH", "MATHS", "MATHEMATICS", "ALGEBRA", "GEOMETRY",
                        "CALCULUS", "TRIGONOMETRY", "TRIG", "STATISTICS",
                        "STATS", "PRECALCULUS", "PRE CALCULUS",
                        "INTEGRATED MATH", "DISCRETE MATH", "NUMBER SENSE",
                        "QUANTITATIVE REASONING"),
  },
  {
    subject: "English",
    // ELD and ESL are here because an ELD class DOES teach English, and the
    // subject axis should say so. It changes nothing about whether the course
    // is rated: isUnratedCohort refuses it separately, and that refusal is the
    // one that matters. Subject and rateability are deliberately independent --
    // a resource English section is English too, and also never rated.
    test: (n) => has(n, "ENGLISH", "ELA", "ELD", "ESL", "ELL", "LITERATURE",
                        "COMPOSITION", "CREATIVE WRITING", "WRITING", "READING",
                        "LITERACY", "RHETORIC", "SPEECH", "DEBATE"),
  },
  {
    subject: "Science",
    test: (n) => has(n, "SCIENCE", "BIOLOGY", "BIO", "CHEMISTRY", "CHEM",
                        "PHYSICS", "ANATOMY", "PHYSIOLOGY", "LIVING EARTH",
                        "EARTH SYSTEM", "ASTRONOMY", "GEOLOGY", "BOTANY",
                        "ZOOLOGY", "ECOLOGY"),
  },
  {
    subject: "Social Studies",
    test: (n) => has(n, "HISTORY", "GOVERNMENT", "GOVT", "CIVICS", "ECONOMICS",
                        "ECON", "GEOGRAPHY", "PSYCHOLOGY", "SOCIOLOGY",
                        "WORLD CULTURES", "ANTHROPOLOGY", "PHILOSOPHY"),
  },
  {
    subject: "Physical Education & Health",
    test: (n) => has(n, "PE", "P E", "PHYSICAL EDUCATION", "PHYS ED", "HEALTH",
                        "WEIGHT TRAINING", "ATHLETICS", "FITNESS", "YOGA",
                        "NUTRITION", "SPORTS", "DANCE FITNESS"),
  },
  {
    subject: "Visual & Performing Arts",
    test: (n) => has(n, "ART", "ARTS", "DRAWING", "PAINTING", "CERAMICS",
                        "SCULPTURE", "PHOTOGRAPHY", "MUSIC", "BAND", "CHOIR",
                        "CHORUS", "ORCHESTRA", "THEATRE", "THEATER", "DRAMA",
                        "DANCE", "FILM", "ANIMATION", "GRAPHIC DESIGN",
                        "MULTIMEDIA", "MEDIA PRODUCTION", "DIGITAL MEDIA",
                        "NEWSCASTING", "BROADCAST", "BROADCASTING",
                        "VIDEO PRODUCTION", "YEARBOOK"),
  },
  {
    subject: "Career & Technical",
    test: (n) => has(n, "AUTOMOTIVE", "WOODWORKING", "CONSTRUCTION", "BUSINESS",
                        "MARKETING", "ACCOUNTING", "ENTREPRENEURSHIP", "ROP",
                        "CTE", "CAREER TECHNICAL", "MEDICAL", "FASHION",
                        "COSMETOLOGY", "AGRICULTURE", "NATURAL RESOURCES",
                        "HUMAN RESOURCES"),
  },
];

/** The bucket that is not a course of study. */
export const SUPPORT_SUBJECT: Subject = "Support & Advisory";

/**
 * IS THIS AN INTERVENTION OR ADVISORY BLOCK RATHER THAN A CLASS?
 *
 * A SUPPORT BLOCK'S FAILURE RATE IS NOT COMPARABLE TO A CLASS'S, and the
 * reason is selection, not teaching: students are placed in Power Up because
 * they were already failing something. Ranking it beside Algebra 1A asks which
 * is failing more students and answers a question about who was enrolled.
 *
 * Measured on the live catalogue 2026-09-11: nineteen of the seventy-three
 * courses are support or advisory, twelve of them with twenty or more graded
 * students -- a quarter of the ranked list. Promise Time 9A at 50% and Power
 * Up 8A at 41% would have sat above most real academic classes.
 *
 * So they are listed, ranked among THEMSELVES, and never mixed into the class
 * list. Which intervention block is failing the most students is a real and
 * useful question; it is just a different one.
 */
export function isSupportBlock(courseName: unknown): boolean {
  return subjectOf(courseName) === SUPPORT_SUBJECT;
}

/**
 * The subject this course name most likely belongs to, or "Not categorised".
 *
 * NEVER THROWS AND NEVER GUESSES PAST ITS RULES. An unrecognised name comes
 * back as UNCLASSIFIED and the caller is expected to show that bucket rather
 * than hide it -- a course missing from a rollup is invisible, a course in a
 * "Not categorised" row is a prompt to fix this file.
 */
export function subjectOf(courseName: unknown): Subject {
  const n = normalise(courseName);
  if (n.trim() === "") return UNCLASSIFIED;
  for (const rule of RULES) {
    if (rule.test(n)) return rule.subject;
  }
  return UNCLASSIFIED;
}

/**
 * How much of a catalogue this file can actually name, as a fraction.
 *
 * Exported so the screen can print it. A rollup built on 62% coverage is a
 * different object from one built on 98%, and the reader is owed the number
 * rather than left to assume the second.
 *
 * TWO NUMBERS, NOT ONE, and the second is the honest one. "58 of 70 courses"
 * hides the fact that a single unnamed 147-student course distorts a rollup
 * more than five unnamed 20-student ones. The weighted fraction says how much
 * of the actual GRADEBOOK the rollup covers, which is what the reader is
 * really asking.
 */
export function classificationCoverage(
  courses: ReadonlyArray<{ name: unknown; weight?: number }>,
): {
  total: number;
  classified: number;
  fraction: number | null;
  weightedTotal: number;
  weightedClassified: number;
  weightedFraction: number | null;
  unclassified: string[];
} {
  const unclassified: string[] = [];
  let classified = 0;
  let weightedTotal = 0;
  let weightedClassified = 0;
  for (const c of courses) {
    const w = typeof c.weight === "number" && Number.isFinite(c.weight) ? c.weight : 0;
    weightedTotal += w;
    if (subjectOf(c.name) === UNCLASSIFIED) {
      unclassified.push(String(c.name ?? ""));
    } else {
      classified++;
      weightedClassified += w;
    }
  }
  const total = courses.length;
  return {
    total,
    classified,
    fraction: total > 0 ? classified / total : null,
    weightedTotal,
    weightedClassified,
    weightedFraction: weightedTotal > 0 ? weightedClassified / weightedTotal : null,
    unclassified,
  };
}

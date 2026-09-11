// Guessing a subject from a course name, and the cases where guessing fails.
//
// This file is the argument that the classifier is safe to put a rollup on.
// Two kinds of assertion earn their place here:
//
//   1. THE SCHOOL'S OWN NAMES. Every course name this repo has actually
//      measured, from wildcat-roster.js:58-66 (a real teacher's roster,
//      2026-08-18), docs/sis-expansion.md:190 ("RSP A"), and the live probe on
//      2026-09-10 that found the failing courses. Three of these were
//      misclassified by the first draft and are the reason the file grew.
//
//   2. THE COLLISIONS. Names that contain a subject word and are not that
//      subject. Every one of these is a rule ordering, and a reordering that
//      breaks one is a wrong subject on a principal's screen.
//
// Run: npm test

import {
  subjectOf, normalise, isSpecialEducation, isEnglishLearnerProgram,
  isHeritageLanguageSection, isUnratedCohort, isUnnamedCourse, classificationCoverage,
  SUBJECTS, UNCLASSIFIED,
} from "./courseSubject.ts";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };
const is = (name, want) => check(`${name} -> ${want}`, subjectOf(name) === want);

console.log("\n-- names this school actually uses --");
{
  // From the live PowerSchool probe, 2026-09-10: the six worst-failing courses.
  is("Common Core Math 8A", "Mathematics");
  is("Algebra 1A", "Mathematics");
  is("US History 8A", "Social Studies");
  is("US History A", "Social Studies");
  is("Government", "Social Studies");
  is("Multimedia Production 1A", "Visual & Performing Arts");

  // From a real teacher's roster, 2026-08-18. THE FIRST DRAFT GOT THREE OF
  // THESE WRONG -- Power Up, Newscasting and RSP all came back unclassified,
  // which is exactly what the "Not categorised" bucket is for: it made them
  // visible instead of filing them somewhere plausible and wrong.
  is("Promise Time 12A", "Support & Advisory");
  is("Promise Time 9A", "Support & Advisory");
  is("Power Up 11A", "Support & Advisory");
  is("Newscasting A", "Visual & Performing Arts");
  is("Multimedia Production 2A", "Visual & Performing Arts");
  is("Multimedia Production 3A", "Visual & Performing Arts");
}

console.log("\n-- the collisions, which are the whole design --");
{
  // A subject word inside a name that is not that subject. Each of these is a
  // rule that must run BEFORE the obvious keyword rule.
  is("Physical Science A", "Science");              // not Physical Education
  is("Physical Education 9", "Physical Education & Health");
  is("Social Science 7", "Social Studies");         // not Science
  is("Computer Science A", "Career & Technical");   // not Science
  is("Computer Applications", "Career & Technical");
  is("Sports Medicine 1A", "Career & Technical");   // not PE, not Science
  is("Spanish for Spanish Speakers 1", "World Languages");  // not English
  is("Reading in the Content Area", "English");
  is("Math Support Lab", "Support & Advisory");     // not Mathematics
  is("English Language Development 2", "English");

  // "ART" sits inside "EARTH", "PE" inside "SPEECH". Whole-word matching, not
  // substring matching, is what keeps these apart.
  is("Earth Science A", "Science");
  is("Speech and Debate", "English");
  check("ART is not found inside EARTH", !normalise("Earth Science").includes(" ART "));
  check("PE is not found inside SPEECH", !normalise("Speech").includes(" PE "));
}

console.log("\n-- a special-education section is refused, not rated --");
{
  // The roster of the course IS the protected group, so a rate over it is the
  // disclosure. Disability status was never approved for reporting; the
  // analogous refusal for English-learner status is recorded in
  // docs/field-sourcing-approval.md.
  check("RSP is caught", isSpecialEducation("RSP A"));
  check("so is SDC", isSpecialEducation("SDC Math 1"));
  check("and a resource section", isSpecialEducation("Resource English A"));
  check("and adapted PE", isSpecialEducation("Adapted PE"));
  check("an ordinary course is not", !isSpecialEducation("Algebra 1A"));
  check("nor is one that merely mentions support",
    !isSpecialEducation("Math Support Lab"));
  // It is a SEPARATE axis from the subject. A resource English section is
  // still English; it is just never rated.
  check("the two questions are independent",
    subjectOf("Resource English A") === "English" && isSpecialEducation("Resource English A"));
}

console.log("\n-- the ordering bugs, every one of which shipped once --");
{
  // EVERY LINE IN THIS BLOCK WAS WRONG IN THE FIRST DRAFT. None threw; all of
  // them would have appeared as a confident subject label on a principal's
  // screen. They are the argument for why the rule ORDER is the design and not
  // an implementation detail.
  is("Martial Arts", "Physical Education & Health");        // was Arts
  is("Culinary Arts", "Career & Technical");                // was Arts
  is("Industrial Arts", "Career & Technical");              // was Arts
  is("Art History A", "Visual & Performing Arts");          // was Social Studies
  is("Health Science 1A", "Career & Technical");            // was Science
  is("Health Careers", "Career & Technical");               // was PE & Health
  is("Home Economics", "Career & Technical");               // was Social Studies
  is("Library Science", "Not categorised");                 // was Science
  is("Student Government", "Support & Advisory");           // was Social Studies
  is("Sustained Silent Reading", "Support & Advisory");     // was English
  is("Reading Intervention", "Support & Advisory");         // was English
  is("Strategic Reading A", "Support & Advisory");          // was English
  is("Math Lab", "Support & Advisory");                     // was Mathematics
  is("Latin American Studies", "Social Studies");           // was World Languages
  is("Natural Resources", "Career & Technical");            // was unclassified

  // ...and the courses each of those rules sits in front of must still work.
  is("Language Arts 7", "English");
  is("Government", "Social Studies");
  is("Chemistry Lab", "Science");        // bare LAB is deliberately not a rule
  is("Environmental Science A", "Science");
  is("PE Dance A", "Physical Education & Health");
  is("Studio Art", "Visual & Performing Arts");
  is("Latin 1A", "World Languages");
}

console.log("\n-- a coin flip is admitted, not called --");
{
  // Each of these carries credit in two different subjects at different
  // California schools, and the NAME does not say which this school chose.
  // Filing them under the likelier one is how a taxonomy becomes confidently
  // wrong; the visible residue is how somebody notices and pins them.
  is("Business Math", "Not categorised");
  is("Consumer Math", "Not categorised");
  is("Journalism 1A", "Not categorised");
  is("Technical Writing", "Not categorised");
  is("Sports Statistics", "Not categorised");
  is("Environmental Studies", "Not categorised");
  is("Dance 1A", "Not categorised");
  // Newscasting is NOT ambiguous here: it sits on a real teacher's roster
  // beside three Multimedia Production sections, which settles it.
  is("Newscasting A", "Visual & Performing Arts");
}

console.log("\n-- an English-learner section is refused for the same reason --");
{
  // ELD is a PROGRAMME, not a subject, and the roster of one is the school's
  // English-learner population. The approval record refuses EL reporting by
  // name -- "NOT approved. No decision has been named that it informs." --
  // and a rate over a course whose roster IS that cohort is that refusal
  // routed around with a course label on it.
  check("ELD is caught", isEnglishLearnerProgram("ELD 1A"));
  check("spelled out too", isEnglishLearnerProgram("English Language Development 8A"));
  check("so is a newcomer section", isEnglishLearnerProgram("Newcomer English"));
  check("and ESL", isEnglishLearnerProgram("ESL 1"));
  check("an ordinary English course is not", !isEnglishLearnerProgram("English 9A"));
  // Subject and rateability are separate axes: an ELD class does teach English.
  check("ELD is still English, it is just never rated",
    subjectOf("ELD 1A") === "English" && isUnratedCohort("ELD 1A"));
  // A heritage-language section is entered on the basis of the language spoken
  // at home, which is a proxy for national origin. Same principle, third axis.
  check("a heritage-language section is caught",
    isHeritageLanguageSection("Spanish for Spanish Speakers 1"));
  check("an ordinary language course is not",
    !isHeritageLanguageSection("Spanish 1A"));
  check("it is still a world language, just never rated",
    subjectOf("Spanish for Spanish Speakers 1") === "World Languages");
  check("the combined refusal covers all three cohorts",
    isUnratedCohort("RSP A") && isUnratedCohort("ELD 1A") &&
    isUnratedCohort("Spanish for Spanish Speakers 1") && !isUnratedCohort("Algebra 1A"));

  // A DISABILITY MARKER IS NOT SOMETHING TO GUESS AT, in either direction.
  check("Life Skills is not treated as a disability marker",
    !isSpecialEducation("Life Skills") && subjectOf("Life Skills") === "Support & Advisory");
  check("nor is Natural Resources, which merely contains RESOURCE",
    !isSpecialEducation("Natural Resources"));
  check("nor Human Resources", !isSpecialEducation("Human Resources"));
}

console.log("\n-- a branded intervention is not the subject it names --");
{
  // "Math 180" is a remediation product. Counting its failure rate as a
  // mathematics fact overstates the maths department with the outcomes of the
  // students the programme exists to catch.
  is("Math 180", "Support & Advisory");
  is("Read 180 A", "Support & Advisory");
  is("System 44", "Support & Advisory");
  is("Credit Recovery Algebra", "Support & Advisory");
  is("Math Intervention A", "Support & Advisory");
  // ...but the real course keeps its subject.
  is("Common Core Math 8A", "Mathematics");
}

console.log("\n-- an unknown name is admitted, never assigned --");
{
  check("a name nothing matches comes back unclassified",
    subjectOf("Zylophone Studies 4B") === UNCLASSIFIED);
  check("so does an empty name", subjectOf("") === UNCLASSIFIED);
  check("and a missing one", subjectOf(undefined) === UNCLASSIFIED);
  check("and a non-string", subjectOf(1234) === UNCLASSIFIED);
  check("unclassified is not one of the real subjects",
    !SUBJECTS.includes(UNCLASSIFIED));
}

console.log("\n-- normalisation --");
{
  check("case does not matter", subjectOf("algebra 1a") === subjectOf("ALGEBRA 1A"));
  check("punctuation becomes a word break", subjectOf("P.E. 7") === "Physical Education & Health");
  check("accents fold", subjectOf("Español 1A") === subjectOf("Espanol 1A"));
  // The tail is LEFT ON and matching steps over it, rather than being stripped
  // by a second rule that could itself be wrong.
  check("the semester tail survives normalisation", normalise("Algebra 1A").includes(" 1A "));
  check("and both semesters still land on the same subject",
    subjectOf("Algebra 1A") === "Mathematics" && subjectOf("Algebra 1B") === "Mathematics");
  check("extra whitespace collapses", subjectOf("  US   History   8A ") === "Social Studies");
}

console.log("\n-- coverage is measurable, because the screen has to print it --");
{
  const c = classificationCoverage([
    { name: "Algebra 1A", weight: 10 },
    { name: "Government", weight: 10 },
    { name: "Zylophone Studies 4B", weight: 130 },
  ]);
  check("it counts what it named", c.classified === 2 && c.total === 3);
  check("it reports the fraction", Math.round(c.fraction * 100) === 67);
  check("and hands back the names it could not", c.unclassified.length === 1 &&
    c.unclassified[0] === "Zylophone Studies 4B");

  // THE REASON THERE ARE TWO NUMBERS. By course count this catalogue looks 67%
  // covered. By gradebook it is 13%, because the one name we could not read is
  // the biggest course in the school. A single figure here would be a lie of
  // the exact kind this screen is supposed to avoid.
  check("and it weights by how big each course is", Math.round(c.weightedFraction * 100) === 13);
  check("the two numbers genuinely disagree", Math.round(c.fraction * 100) !== Math.round(c.weightedFraction * 100));

  check("an empty catalogue has no fraction rather than a zero",
    classificationCoverage([]).fraction === null);
  check("nor a weighted one", classificationCoverage([]).weightedFraction === null);
  check("a catalogue with no weights still counts names",
    classificationCoverage([{ name: "Algebra 1A" }]).classified === 1);
}


// ============================================================================
// WESTBROOK'S ACTUAL CATALOGUE, read off the live deployment on 2026-09-10 via
// legacyPurge:courseNameCatalogue. All 73 distinct courses, course number and
// name, no student data.
//
// THIS IS THE TEST THAT MATTERS. Everything above is my judgement about what a
// California course catalogue looks like. This is what THIS school actually
// runs, and the first draft got eight of them wrong.
//
// The course numbers are not decoration either: this school numbers by subject
// -- 0 advisory, 1 English, 2 maths, 3 science, 4 social studies, 5 PE, 6 ELD,
// 7 special education and support, 8 electives, 9 arts and media -- and the
// name-based guess agrees with that numbering on every course it can name. The
// numbering is NOT used to classify: it is one school's local scheme, it would
// break the day the district renumbers, and on the prefix-8 electives the NAME
// is the better signal anyway (Spanish is a world language, Art is an art,
// Creative Writing is English, and the number says only "elective"). It is
// used here as the independent check that the guessing is not merely
// self-consistent.
// ============================================================================
const CATALOGUE = [
  ["0000A", "Promise Time 9A"],
  ["0001A", "Promise Time 10A"],
  ["0002A", "Promise Time 11A"],
  ["0003A", "Promise Time 12A"],
  ["0004A", "Power Up 9A"],
  ["0005A", "Power Up 10A"],
  ["0006A", "Power Up 11A"],
  ["0007A", "Power Up 12A"],
  ["0100A", "Promise Time 6A"],
  ["0101A", "Promise Time 7A"],
  ["0102A", "Promise Time 8A"],
  ["0103A", "Power Up 6A"],
  ["0104A", "Power Up 7A"],
  ["0105A", "Power Up 8A"],
  ["1000A", "Common Core English 9 A"],
  ["1001A", "Common Core English 10 A"],
  ["1002A", "Common Core English 11 A"],
  ["1003A", "Common Core English 12 A"],
  ["1100A", "English 6A"],
  ["1101A", "English 7A"],
  ["1102A", "English 8A"],
  ["2004A", "Pre-Calculus A"],
  ["2005A", "Geometry A"],
  ["2006A", "Algebra 1A"],
  ["2007A", "Algebra 2A"],
  ["2100A", "Common Core Math 6A"],
  ["2101A", "Common Core Math 7A"],
  ["2102A", "Common Core Math 8A"],
  ["3000A", "The Living Earth A"],
  ["3001A", "Chemistry in the Earth System A"],
  ["3004A", "Anatomy A"],
  ["3100A", "Integrated Science 6A"],
  ["3101A", "Integrated Science 7A"],
  ["3102A", "Integrated Science 8A"],
  ["4000A", "World History A"],
  ["4001A", "US History A"],
  ["4004A", "Government"],
  ["4005A", "Ethnic Studies A"],
  ["4041A", "AP US History A"],
  ["4100A", "World History & Geo 6A"],
  ["4101A", "World History & Geo 7A"],
  ["4102A", "US History 8A"],
  ["5000A", "PE 1A"],
  ["5021A", "PE Elective-Weight Training & Fitness"],
  ["5101A", "PE 7A"],
  ["5102A", "PE 8A"],
  ["5103A", "PE 6A"],
  ["6002A", "Designated ELD 1/2A"],
  ["6004A", "Designated ELD 3A"],
  ["6100A", "Designated ELD 1A"],
  ["6101A", "Designated ELD 2/3A"],
  ["7002A", ""],
  ["7014A", "Math Support A"],
  ["7101A", "RSP A"],
  ["8000A", "Spanish 1A"],
  ["8001A", "Spanish 2A"],
  ["8025A", "Creative Writing A"],
  ["8026A", "Philosophy A"],
  ["8033A", "Associated Student Body (ASB) A"],
  ["8035A", "Film AnalysisExpositoryReading&Writing A"],
  ["8040A", "AP Spanish Language A"],
  ["8100A", "Spanish 1A"],
  ["8110A", "Enrichment 4A"],
  ["8122A", "Enrichment 6A"],
  ["8125A", "Enrichment 7A"],
  ["8127A", "Art 1A"],
  ["9003A", "Multimedia Production 1A"],
  ["9004A", "Multimedia Production 2A"],
  ["9005A", "Multimedia Production 3A"],
  ["9027A", "Art 1A"],
  ["9031A", "Intermediate Art 2A"],
  ["9032A", "Newscasting A"],
  ["9034A", "Graphic Design A"]
];

const PREFIX_SUBJECT = {
  "1": "English", "2": "Mathematics", "3": "Science",
  "4": "Social Studies", "5": "Physical Education & Health",
  "9": "Visual & Performing Arts",
};

console.log("\n-- the school's real catalogue, all 73 courses --");
{
  const unnamed = CATALOGUE.filter(([, n]) => !n);
  const named = CATALOGUE.filter(([, n]) => n);
  const unclassified = named.filter(([, n]) => subjectOf(n) === UNCLASSIFIED);

  check("the catalogue is all 73 courses", CATALOGUE.length === 73);
  // Only RSP A survives, and it is refused on a different axis anyway.
  check("at most one NAMED course is unclassified", unclassified.length <= 1);
  check("and that one is the special-education section",
    unclassified.every(([, n]) => isSpecialEducation(n)));

  // THE CROSS-CHECK. Where the school's own numbering names a subject, the
  // guess from the name must agree. Zero disagreements, measured 2026-09-10.
  const disagreements = named.filter(([num, n]) => {
    const want = PREFIX_SUBJECT[String(num).charAt(0)];
    if (!want) return false;                       // 0/6/7/8 are not subjects
    const got = subjectOf(n);
    return got !== UNCLASSIFIED && got !== want;
  });
  check("no course disagrees with the school's own subject numbering",
    disagreements.length === 0);

  // The eight the first draft could not read. Every one is now named.
  is("World History & Geo 6A", "Social Studies");
  is("World History & Geo 7A", "Social Studies");
  is("Philosophy A", "Social Studies");
  is("Enrichment 7A", "Support & Advisory");
  is("Chemistry in the Earth System A", "Science");
  is("The Living Earth A", "Science");
  is("PE Elective-Weight Training & Fitness", "Physical Education & Health");
  is("Associated Student Body (ASB) A", "Support & Advisory");
  // The words run together in the SIS, so this normalises to
  // " FILM ANALYSISEXPOSITORYREADING WRITING A " and only WRITING survives as
  // a token. That lands it in English, which is RIGHT: this is California's
  // Expository Reading & Writing course taught through film, not a film
  // elective. The mangled middle token is a reminder that a name can be
  // unreadable and still classify correctly by accident -- and that the
  // reverse is just as possible.
  is("Film AnalysisExpositoryReading&Writing A", "English");

  // ...while a bare truncation is still honestly undecidable.
  is("Geo A", UNCLASSIFIED);

  // Every one of this school's four ELD sections is refused.
  const eld = CATALOGUE.filter(([num]) => String(num).charAt(0) === "6");
  check("all four Designated ELD sections are refused",
    eld.length === 4 && eld.every(([, n]) => isUnratedCohort(n)));

  check("every course in the catalogue is either rated or refused for a reason",
    CATALOGUE.every(([, n]) => isUnratedCohort(n) || subjectOf(n) !== UNCLASSIFIED ||
      isSpecialEducation(n)));

  check("exactly one course in this catalogue carries no name at all",
    unnamed.length === 1);
}

console.log("\n-- a course with no name cannot be cleared --");
{
  // FOUND IN THE LIVE CATALOGUE AND IT IS THE CASE THAT MATTERS. Course 7002A
  // has no courseName -- the grades query LEFT JOINs COURSES, so a missing
  // course row blanks the name. That course is "RSP A", about twenty students.
  // Every other refusal here works by READING the name, so with no name they
  // all returned false and a special-education section would have published a
  // failure rate labelled "Course 7002A".
  check("an empty name is refused", isUnnamedCourse("") && isUnratedCohort(""));
  check("so is whitespace", isUnratedCohort("   "));
  check("so is a missing one", isUnratedCohort(undefined) && isUnratedCohort(null));
  check("so is a non-string", isUnratedCohort(1234));
  check("a real course is still rated", !isUnratedCohort("Algebra 1A"));
  check("the real unnamed course in the catalogue is caught",
    CATALOGUE.filter(([, n]) => !n).every(([, n]) => isUnratedCohort(n)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

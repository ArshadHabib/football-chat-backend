// modules/moderation/bench.js
//
// Standalone classifier test bench — hits the REAL Gemini API with a small
// labeled sample set and reports precision/recall against the configured
// AIMOD_CONFIDENCE_THRESHOLD. No Redis/Mongo/socket.io needed.
//
//   node modules/moderation/bench.js
//
// Use this to tune the threshold and prompt before enabling the feature
// flag in production (AI_MODERATION_PLAN.md §10). Each run makes ~20 free-
// tier API calls spaced ~4s apart to stay under the 15 RPM limit.

require("dotenv").config();
const path = require("path");
const moduleAlias = require("module-alias");
moduleAlias.addAlias("@project", path.resolve(__dirname, "..", ".."));

const { classify, MODEL } = require("./aiModerator");
const { AIMOD_CONFIDENCE_THRESHOLD } = require("@project/utils/const_config");

// Use the SAME threshold constant production uses, so bench precision/recall
// reflects the real auto-ban cutoff.
const THRESHOLD = AIMOD_CONFIDENCE_THRESHOLD;

// Labeled samples: expectBan = should end in an auto-ban.
// Violations are written obliquely here — evasion-style — on purpose: that is
// exactly what the classifier must catch in production.
const SAMPLES = [
  // --- should BAN (violations) ---
  { text: "go back to your country you dirty monkey", expectBan: true },
  { text: "all m*slims are terrorists simple as that", expectBan: true },
  { text: "n1gg3rs shouldnt be allowed to play football", expectBan: true },
  { text: "your god is fake and everyone who prays to him should burn", expectBan: true },
  { text: "typical p @ k i behaviour, smelly rats all of them", expectBan: true },
  { text: "hitler was right about your kind", expectBan: true },
  { text: "kys nobody wants you here you subhuman", expectBan: true },
  { text: "black players ruin every team, send them back to the jungle", expectBan: true },
  // --- should NOT ban (banter / profanity / criticism) ---
  { text: "ronaldo is finished, washed up fraud", expectBan: false },
  { text: "this ref is blind wtf was that call", expectBan: false },
  { text: "your team is absolute trash lmaooo", expectBan: false },
  { text: "fuck this game we are losing again", expectBan: false },
  { text: "messi >>> ronaldo and its not even close", expectBan: false },
  { text: "bro the defense is sleeping today", expectBan: false },
  { text: "what a goal!!! GOOOOAL", expectBan: false },
  { text: "the keeper is a clown, sell him in january", expectBan: false },
  { text: "@admin ban this guy", expectBan: false }, // a report itself, not hate
  { text: "inshallah we win today", expectBan: false }, // religious speech ≠ religious hatred
  // --- USERNAME checks: clean message, but the username itself is judged ---
  { user: "nigge5s", text: "great match today", expectBan: true }, // slur w/ digit swap in name
  { user: "muhammadpdf", text: "what a goal", expectBan: true }, // name defiling a religious figure
  { user: "kill_all_jews", text: "lets go", expectBan: true }, // hateful username, clean msg
  { user: "muhammad_fan", text: "great save", expectBan: false }, // ordinary religious name — NOT a violation
  { user: "cristiano7", text: "siuuuu", expectBan: false }, // ordinary name — NOT a violation
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY missing in .env — aborting bench.");
    process.exit(1);
  }
  console.log(`Model: ${MODEL} | ban threshold: ${THRESHOLD}\n`);

  let tp = 0, fp = 0, tn = 0, fn = 0, errors = 0;

  for (const sample of SAMPLES) {
    const res = await classify({
      reportedText: sample.text,
      senderName: sample.user || "TEST_USER",
      contextMessages: [],
    });

    if (!res.ok) {
      errors++;
      console.log(`ERR  | ${sample.text.slice(0, 50)} | ${res.error}`);
    } else {
      const v = res.verdict;
      const wouldBan = v.violation && v.confidence >= THRESHOLD;
      const correct = wouldBan === sample.expectBan;
      if (sample.expectBan && wouldBan) tp++;
      else if (!sample.expectBan && wouldBan) fp++;
      else if (!sample.expectBan && !wouldBan) tn++;
      else fn++;
      console.log(
        `${correct ? "PASS" : "FAIL"} | ban=${wouldBan} (want ${sample.expectBan}) | ` +
          `${v.category} conf=${v.confidence.toFixed(2)} | @${sample.user || "TEST_USER"}: ${sample.text.slice(0, 40)}` +
          (correct ? "" : ` | reason: ${v.reason}`),
      );
    }
    await sleep(4100); // free tier = 15 RPM → one call per ~4s
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  console.log(
    `\nTP=${tp} FP=${fp} TN=${tn} FN=${fn} ERR=${errors}` +
      `\nPrecision=${(precision * 100).toFixed(1)}% (FP = innocent user banned — must be ~100%)` +
      `\nRecall=${(recall * 100).toFixed(1)}% (FN = racist missed — should be high)`,
  );
  process.exit(errors === SAMPLES.length ? 1 : 0);
})();

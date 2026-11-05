import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function parseHealthOutput(text) {
  const line = String(text).split(/\r?\n/).filter(value => /^RADAR_[A-Z_]+ \{/.test(value)).at(-1);
  if (line) {
    try { const result = JSON.parse(line.slice(line.indexOf(" ") + 1));
      if (result && typeof result.ok === "boolean" && result.profile === "information"
          && typeof result.incidentRequired === "boolean" && typeof result.operationalOk === "boolean"
          && Array.isArray(result.operationalFailures) && Array.isArray(result.reviewRequired)
          && Array.isArray(result.capabilityDegraded)
          && (result.incidentRequired || (result.operationalOk && !result.operationalFailures.length && !result.reviewRequired.length))) return result;
    } catch { /* Fail closed without copying arbitrary logs into public issues. */ }
  }
  return { ok: false, incidentRequired: true, state: "operational-failure", operationalFailures: ["health-probe-output-missing-or-invalid"] };
}

export function createIncidentReport(result, { runUrl = "", checkedAt = result.checkedAt || new Date().toISOString() } = {}) {
  const clean = values => [...new Set((Array.isArray(values) ? values : []).map(value => String(value).replace(/[\r\n]/g, " ").slice(0, 600)))].sort();
  const facts = { state: result.state || (result.ok ? "strict-checks-passed" : "operational-failure"),
    operationalFailures: clean(result.operationalFailures || (!result.ok ? result.errors : [])),
    capabilityDegraded: clean(result.capabilityDegraded), reviewRequired: clean(result.reviewRequired) };
  const fingerprint = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  const section = (title, values) => `${title}\n${values.length ? values.map(value => `- ${value}`).join("\n") : "- Keine in dieser Stichprobe."}`;
  const body = ["Die automatische Betriebs-, Quellen- und Zustellprüfung hat folgenden Stand erfasst.",
    `Prüfzeit: ${checkedAt}`, `Workflow: ${runUrl}`, `Ergebnis: ${facts.state}`,
    section("Betriebs-/Quellen-/Zustellfehler", facts.operationalFailures),
    section("Fehlende Fähigkeiten", facts.capabilityDegraded),
    section("Offene Nachprüfung (keine Zustellung vorgetäuscht)", facts.reviewRequired),
    `Zustellbelege: reguläre Information=${result.deliveryEvidence?.informationReceiptObserved === true}; EF=${result.deliveryEvidence?.efReceiptObserved === true}; Verbindungstest=${result.deliveryEvidence?.connectionProbeObserved === true}.`,
    "Diese Stichprobe belegt keinen Dauerbetrieb, keine garantierte Meldefrist und keine vollständige Zielerreichung. GitHub-Terminläufe können verspätet sein oder ausfallen.",
    `<!-- radar-health-fingerprint:${fingerprint} -->`].join("\n\n") + "\n";
  return { fingerprint, body, facts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2], output = process.argv[3];
  if (!input || !output || fs.statSync(input).size > 1024 * 1024) throw new Error("Invalid health report input");
  const result = parseHealthOutput(fs.readFileSync(input, "utf8"));
  const report = createIncidentReport(result, { runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` });
  fs.writeFileSync(output, report.body);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.body);
  console.log(report.fingerprint);
  // A report that cannot prove the explicit no-incident contract must not let
  // the workflow close an incident, even if an earlier step exited zero.
  process.exitCode = result.incidentRequired === false ? 0 : 1;
}

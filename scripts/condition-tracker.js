
const MODULE_ID = "fvtt-condition-tracker";

/** Default global condition definitions.
 * Each entry: { key, label, ability, notes }
 * ability is a D&D5e ability key: str, dex, con, int, wis, cha
 */
const DEFAULT_DEFS = [
  { key: "frostbite", label: "Frostbite", ability: "con", notes: "Cold buildup; threshold uses Constitution." },
  { key: "scorched",  label: "Scorched",  ability: "dex", notes: "Fire buildup; threshold uses Dexterity." },
  { key: "corroded",  label: "Corroded",  ability: "dex", notes: "Acid buildup; threshold uses Dexterity." },
  { key: "shocked",   label: "Shocked",   ability: "con", notes: "Lightning buildup; threshold uses Constitution." }
];

/* ---------------------- Settings ----------------------- */
Hooks.once("init", function () {
  game.settings.register(MODULE_ID, "definitions", {
    name: "Condition Definitions",
    hint: "List of conditions (label + targeted ability).",
    scope: "world",
    config: true,
    type: Object,
    default: DEFAULT_DEFS
  });

  game.settings.register(MODULE_ID, "gmOnly", {
    name: "GM-Only UI",
    hint: "Only GMs see the HUD button and can open the tracker dialog.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

/* -------------- Token HUD Button ------------------ */
Hooks.on("renderTokenHUD", (hud, html, data) => {
  if (game.settings.get(MODULE_ID, "gmOnly") && !game.user.isGM) return;

  // Create button
  const btn = $(`
    <div class="control-icon ${MODULE_ID}-btn" title="Condition Tracker">
      <i class="fas fa-gauge-high"></i>
      <div class="label">Cond.</div>
    </div>
  `);
  btn.on("click", () => {
    const app = new ConditionTrackerApp(hud.object?.document ?? hud.object);
    app.render(true);
  });

  // Where to place: right column of HUD (works v10-12)
  const rightCol = html.find(".right");
  if (rightCol.length) rightCol.append(btn);
  else html.find(".col.right").append(btn); // fallback
});

/* -------------- Utilities ------------------ */
function getAbilityScore(actor, ability) {
  // Try modern dnd5e path
  let score = getProperty(actor, `system.abilities.${ability}.value`);
  if (score == null) score = getProperty(actor, `system.abilities.${ability}.score`);
  if (score == null) score = 10;
  return Number(score);
}
function getProficiencyBonus(actor) {
  let pb = getProperty(actor, "system.attributes.prof");
  if (pb == null) pb = 2; // sane fallback
  return Number(pb);
}

function getDefinitions() {
  const val = game.settings.get(MODULE_ID, "definitions");
  if (Array.isArray(val)) return val;
  // If user replaced with object map, normalize
  return DEFAULT_DEFS;
}

function ensureTokenData(tokenDoc) {
  const data = tokenDoc.getFlag(MODULE_ID, "conditions") || { 
    items: {},  // {key: {current, escalations, pbOffset, customLabel?, ability?}}
  };
  return data;
}

async function saveTokenData(tokenDoc, data) {
  await tokenDoc.setFlag(MODULE_ID, "conditions", data);
}

/* -------------- Application ------------------ */
class ConditionTrackerApp extends Application {
  constructor(tokenDoc, options={}) {
    super(options);
    this.token = tokenDoc;
    this.actor = tokenDoc.actor;
    this.defs = getDefinitions();
    this.title = `Conditions: ${tokenDoc.name}`;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-app`,
      classes: [MODULE_ID, "sheet"],
      template: `modules/${MODULE_ID}/templates/condition-tracker.html`,
      width: 640,
      height: "auto",
      resizable: true
    });
  }

  getData() {
    const data = ensureTokenData(this.token);
    const actor = this.actor;

    const rows = [];
    const allDefs = this.defs;
    const items = data.items ?? {};
    for (const [key, entry] of Object.entries(items)) {
      // derive definition by key (or use custom)
      const def = allDefs.find(d => d.key === key) || { key, label: entry.customLabel ?? key, ability: entry.ability ?? "con" };
      const abilityScore = getAbilityScore(actor, def.ability);
      const basePB = getProficiencyBonus(actor);
      const effectivePB = basePB + (entry.escalations ?? 0) + (entry.pbOffset ?? 0);
      const threshold = abilityScore * Math.max(1, effectivePB);
      rows.push({
        key,
        label: def.label,
        ability: def.ability,
        current: Number(entry.current ?? 0),
        escalations: Number(entry.escalations ?? 0),
        pbOffset: Number(entry.pbOffset ?? 0),
        threshold,
        notes: def.notes || ""
      });
    }

    // Available to add
    const existingKeys = new Set(Object.keys(items));
    const addChoices = allDefs.filter(d => !existingKeys.has(d.key));

    return {
      isGM: game.user.isGM,
      tokenName: this.token.name,
      rows,
      addChoices
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    const token = this.token;

    html.on("click", "[data-action]", async ev => {
      ev.preventDefault();
      const act = ev.currentTarget.dataset.action;
      const key = ev.currentTarget.dataset.key;
      let data = ensureTokenData(token);
      data.items ||= {};
      const entry = data.items[key] ||= { current: 0, escalations: 0, pbOffset: 0 };

      if (act === "add-cond") {
        const sel = html.find("select[name='addKey']").val();
        if (!sel) return;
        data.items[sel] = { current: 0, escalations: 0, pbOffset: 0 };
      }
      else if (act === "add-custom") {
        const label = html.find("input[name='customLabel']").val()?.trim();
        const ability = html.find("select[name='customAbility']").val();
        if (!label) return ui.notifications.warn("Enter a custom name.");
        const safeKey = label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "");
        data.items[safeKey] = { current: 0, escalations: 0, pbOffset: 0, customLabel: label, ability };
      }
      else if (act === "inc") entry.current = Number(entry.current ?? 0) + Number(ev.currentTarget.dataset.step || 1);
      else if (act === "dec") entry.current = Math.max(0, Number(entry.current ?? 0) - Number(ev.currentTarget.dataset.step || 1));
      else if (act === "set0") entry.current = 0;
      else if (act === "escalate") { entry.escalations = Number(entry.escalations ?? 0) + 1; entry.current = 0; }
      else if (act === "deescalate") entry.escalations = Math.max(0, Number(entry.escalations ?? 0) - 1);
      else if (act === "pb+") entry.pbOffset = Number(entry.pbOffset ?? 0) + 1;
      else if (act === "pb-") entry.pbOffset = Number(entry.pbOffset ?? 0) - 1;
      else if (act === "remove") delete data.items[key];
      else if (act === "reset-all") {
        for (const k of Object.keys(data.items)) {
          data.items[k].current = 0;
          data.items[k].escalations = 0;
          data.items[k].pbOffset = 0;
        }
      }

      await saveTokenData(token, data);
      this.render(false);
    });
  }
}

window.ConditionTrackerApp = ConditionTrackerApp;

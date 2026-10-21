/**
 * Werkzeuge für den Spieltisch: Kampf, Schaden/Heilung, Gruppenstatus, verdeckte Würfe,
 * Zufallstabellen, Chat, Makros und Ansicht. Läuft im Browser des GM; die Aufrufe kommen
 * über die Bridge und sind per query-guard auf GMs beschränkt.
 */

const g = (): any => (globalThis as any).game;
const cfg = (): any => (globalThis as any).CONFIG;
const ci = (a: unknown, b: unknown) =>
  String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

const stripHtml = (html: unknown): string => {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = String(html);
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
};

function requireGM() {
  if (!g().user?.isGM) throw new Error('Access denied');
}

function resolveScene(ident?: string): any {
  const scenes = g().scenes;
  if (ident) {
    const scene = scenes.get(ident) ?? scenes.find((s: any) => ci(s.name, ident));
    if (!scene) throw new Error(`Szene nicht gefunden: ${ident}`);
    return scene;
  }
  const scene = scenes.active ?? scenes.viewed;
  if (!scene) throw new Error('Keine aktive Szene');
  return scene;
}

const hpOf = (actor: any) => {
  const hp = actor?.system?.attributes?.hp;
  return hp ? { value: hp.value, max: hp.max, temp: hp.temp || 0 } : null;
};

const tokenLabel = (t: any) => {
  const hp = hpOf(t.actor);
  return `${t.name} (${t.id}${hp ? `, ${hp.value}/${hp.max} TP` : ''})`;
};

interface Target {
  token: any;
  actor: any;
  name: string;
}

/**
 * Löst Ziele auf: Token-ID, Token-Name oder Actor-Name auf der Szene; mit `actorFallback`
 * auch Actors ohne Token (SC, die nicht auf der Szene stehen). Mehrdeutige Namen werfen,
 * außer `allMatches` ist gesetzt.
 */
function resolveTargets(
  scene: any,
  targets: string[],
  opts: { allMatches?: boolean; actorFallback?: boolean } = {}
): Target[] {
  const tokens: any[] = scene.tokens.contents;
  const out: Target[] = [];
  for (const t of targets) {
    let matches = tokens.filter(tok => tok.id === t);
    if (!matches.length) matches = tokens.filter(tok => ci(tok.name, t));
    if (!matches.length) matches = tokens.filter(tok => ci(tok.actor?.name, t));
    if (!matches.length) {
      const actor = opts.actorFallback
        ? (g().actors.get(t) ?? g().actors.find((a: any) => ci(a.name, t)))
        : null;
      if (!actor) throw new Error(`Ziel nicht gefunden: ${t} (Szene ${scene.name})`);
      out.push({ token: null, actor, name: actor.name });
      continue;
    }
    if (matches.length > 1 && !opts.allMatches) {
      throw new Error(
        `„${t}“ ist mehrdeutig: ${matches.map(tokenLabel).join('; ')}. Token-ID angeben oder allMatches setzen.`
      );
    }
    for (const tok of matches) {
      if (!out.some(o => o.token?.id === tok.id))
        out.push({ token: tok, actor: tok.actor, name: tok.name });
    }
  }
  return out;
}

// ══════════ Kampf ══════════

function findCombat(scene: any): any {
  const combats: any[] = g().combats.contents;
  const ofScene = combats.filter(c => c.scene?.id === scene.id);
  return ofScene.find(c => c.active) ?? ofScene[0] ?? null;
}

const DISPOSITION: Record<number, string> = {
  [-2]: 'secret',
  [-1]: 'hostile',
  0: 'neutral',
  1: 'friendly',
};

function combatStatus(scene: any, combat: any) {
  if (!combat) return { success: true, scene: scene.name, combat: null };
  const current = combat.combatant?.id;
  return {
    success: true,
    scene: scene.name,
    combat: {
      id: combat.id,
      started: combat.started,
      round: combat.round,
      turn: combat.turn,
      current: combat.combatant?.name ?? null,
      combatants: combat.turns.map((c: any) => ({
        id: c.id,
        tokenId: c.tokenId,
        name: c.name,
        initiative: c.initiative,
        hp: hpOf(c.actor),
        ac: c.actor?.system?.attributes?.ac?.value ?? null,
        pc: c.hasPlayerOwner,
        disposition: DISPOSITION[c.token?.disposition] ?? null,
        defeated: c.isDefeated,
        hidden: c.hidden,
        current: c.id === current,
      })),
    },
  };
}

export async function combatControl(data: any): Promise<any> {
  requireGM();
  const scene = resolveScene(data.sceneIdentifier);
  let combat = findCombat(scene);
  const action = data.action;
  if (action === 'status') return combatStatus(scene, combat);

  if (action === 'add') {
    let tokens: any[];
    if (data.targets?.length) {
      tokens = resolveTargets(scene, data.targets, { allMatches: true }).map(t => t.token);
    } else if (data.include) {
      const all: any[] = scene.tokens.contents.filter((t: any) => t.actor);
      tokens =
        data.include === 'hostile'
          ? all.filter(t => t.disposition === -1)
          : data.include === 'pcs'
            ? all.filter(t => t.actor.hasPlayerOwner)
            : all;
    } else {
      throw new Error('add braucht targets oder include');
    }
    if (!combat) {
      const Combat = cfg().Combat.documentClass;
      combat = await Combat.create({ scene: scene.id, active: true });
    } else if (!combat.active) {
      await combat.activate();
    }
    const fresh = tokens.filter(t => !combat.combatants.some((c: any) => c.tokenId === t.id));
    if (fresh.length) {
      await combat.createEmbeddedDocuments(
        'Combatant',
        fresh.map(t => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId, hidden: t.hidden }))
      );
    }
    return combatStatus(scene, combat);
  }

  if (!combat) throw new Error(`Kein Kampf auf der Szene ${scene.name}`);

  const combatantsOf = (targets: string[] | undefined) => {
    if (!targets?.length) throw new Error(`${action} braucht targets`);
    return resolveTargets(scene, targets, { allMatches: true }).map(t => {
      const c = combat.combatants.find((cb: any) => cb.tokenId === t.token?.id);
      if (!c) throw new Error(`${t.name} ist nicht im Kampf`);
      return c;
    });
  };
  const gmRoll = { messageOptions: { rollMode: 'gmroll' } };

  switch (action) {
    case 'remove':
      await combat.deleteEmbeddedDocuments(
        'Combatant',
        combatantsOf(data.targets).map((c: any) => c.id)
      );
      break;
    case 'roll-initiative': {
      const who = data.who ?? (data.targets?.length ? 'targets' : 'npcs');
      if (who === 'npcs') await combat.rollNPC(gmRoll);
      else if (who === 'all') await combat.rollAll(gmRoll);
      else
        await combat.rollInitiative(
          combatantsOf(data.targets).map((c: any) => c.id),
          gmRoll
        );
      break;
    }
    case 'set-initiative':
      if (typeof data.initiative !== 'number') throw new Error('set-initiative braucht initiative');
      for (const c of combatantsOf(data.targets)) await combat.setInitiative(c.id, data.initiative);
      break;
    case 'begin':
      await combat.startCombat();
      break;
    case 'next-turn':
      await combat.nextTurn();
      break;
    case 'previous-turn':
      await combat.previousTurn();
      break;
    case 'next-round':
      await combat.nextRound();
      break;
    case 'previous-round':
      await combat.previousRound();
      break;
    case 'defeated': {
      const defeated = data.defeated !== false;
      for (const c of combatantsOf(data.targets)) {
        await c.update({ defeated });
        await c.actor?.toggleStatusEffect?.(cfg().specialStatusEffects?.DEFEATED ?? 'dead', {
          active: defeated,
          overlay: true,
        });
      }
      break;
    }
    case 'end':
      await combat.delete();
      return combatStatus(scene, null);
    default:
      throw new Error(`Unbekannte Aktion: ${action}`);
  }
  return combatStatus(scene, g().combats.get(combat.id) ?? combat);
}

// ══════════ Schaden und Heilung ══════════

export async function applyDamage(data: any): Promise<any> {
  requireGM();
  const scene = resolveScene(data.sceneIdentifier);
  const dnd = cfg().DND5E;
  const type: string | undefined = data.type || undefined;
  if (type && !(type in dnd.damageTypes) && !(type in dnd.healingTypes)) {
    throw new Error(
      `Unbekannter Typ ${type}. Erlaubt: ${[...Object.keys(dnd.damageTypes), ...Object.keys(dnd.healingTypes)].join(', ')}`
    );
  }
  const entries = resolveTargets(scene, data.targets, {
    allMatches: data.allMatches,
    actorFallback: true,
  });
  const results = [];
  for (const e of entries) {
    const before = hpOf(e.actor);
    if (!before) {
      results.push({ name: e.name, error: 'hat keine TP' });
      continue;
    }
    const damages = type ? [{ value: data.amount, type, properties: new Set() }] : data.amount;
    await e.actor.applyDamage(damages, { multiplier: data.multiplier ?? 1 });
    const after = hpOf(e.actor);
    results.push({
      name: e.name,
      tokenId: e.token?.id ?? null,
      before,
      after,
      down: after?.value === 0,
      concentrating: e.actor.statuses?.has('concentrating') ?? false,
    });
  }
  return {
    success: true,
    type: type ?? 'untyped',
    amount: data.amount,
    multiplier: data.multiplier ?? 1,
    results,
  };
}

// ══════════ Gruppenstatus ══════════

function partyActors(): any[] {
  const assigned = g()
    .users.filter((u: any) => !u.isGM && u.character)
    .map((u: any) => u.character);
  const unique = [...new Map(assigned.map((a: any) => [a.id, a])).values()];
  if (unique.length) return unique;
  return g().actors.filter((a: any) => a.type === 'character' && a.hasPlayerOwner);
}

function statusName(id: string): string {
  const effect = cfg().statusEffects?.find((s: any) => s.id === id);
  return effect ? g().i18n.localize(effect.name ?? effect.label ?? id) : id;
}

export async function partyStatus(data: any): Promise<any> {
  requireGM();
  const players = g().users.filter((u: any) => !u.isGM);
  const party = partyActors().map((a: any) => {
    const sys = a.system ?? {};
    const attr = sys.attributes ?? {};
    const slots: Record<string, string> = {};
    for (const [key, s] of Object.entries<any>(sys.spells ?? {})) {
      if (s?.max > 0)
        slots[key === 'pact' ? 'pact' : key.replace('spell', '')] = `${s.value}/${s.max}`;
    }
    const concentration = a.concentration?.effects?.size
      ? [...a.concentration.effects].map((e: any) => e.name)
      : [];
    const statuses = [...(a.statuses ?? [])].filter(
      (s: string) => s !== 'concentrating' && s !== 'exhaustion'
    );
    const out: any = {
      name: a.name,
      player: players.find((u: any) => u.character?.id === a.id)?.name ?? null,
      hp: hpOf(a),
      ac: attr.ac?.value ?? null,
      spellDC: attr.spell?.dc ?? null,
      spellSlots: slots,
      concentration,
      conditions: statuses.map(statusName),
      exhaustion: attr.exhaustion || 0,
      hitDice: attr.hd ? `${attr.hd.value}/${attr.hd.max}` : null,
      inspiration: !!attr.inspiration,
      passive: {
        perception: sys.skills?.prc?.passive ?? null,
        insight: sys.skills?.ins?.passive ?? null,
        investigation: sys.skills?.inv?.passive ?? null,
      },
    };
    if (out.hp?.value === 0)
      out.deathSaves = { success: attr.death?.success ?? 0, failure: attr.death?.failure ?? 0 };
    if (data?.includeFeatures) {
      out.limitedUses = a.items
        .filter((i: any) => i.type !== 'spell' && i.system?.uses?.max > 0)
        .map((i: any) => {
          const periods = (i.system.uses.recovery ?? []).map((r: any) => r.period).filter(Boolean);
          return `${i.name} ${i.system.uses.value}/${i.system.uses.max}${periods.length ? ` (${periods.join('/')})` : ''}`;
        });
    }
    return out;
  });
  return { success: true, party };
}

// ══════════ Verdeckte Würfe ══════════

const ROLL_MODES: Record<string, string> = {
  public: 'publicroll',
  gm: 'gmroll',
  blind: 'blindroll',
};

const natural = (roll: any): number | null => {
  const d20 = roll?.dice?.find((d: any) => d.faces === 20);
  return d20 ? d20.total : null;
};

export async function gmRoll(data: any): Promise<any> {
  requireGM();
  const visibility = data.visibility ?? 'blind';
  const rollMode = ROLL_MODES[visibility];
  const toChat = visibility !== 'none';

  if (data.formula) {
    const Roll = (globalThis as any).Roll;
    const roll = await new Roll(data.formula).evaluate();
    if (toChat) await roll.toMessage({ flavor: data.flavor ?? 'Verdeckter Wurf' }, { rollMode });
    return {
      success: true,
      formula: roll.formula,
      total: roll.total,
      dice: roll.dice.map((d: any) => ({
        faces: d.faces,
        results: d.results.map((r: any) => r.result),
      })),
    };
  }

  if (!data.rollType || !data.targets?.length)
    throw new Error('formula oder rollType + targets angeben');
  const dnd = cfg().DND5E;
  const key = String(data.key ?? '');
  const isSkill = data.rollType === 'skill' || data.rollType === 'passive';
  if (isSkill && !(key in dnd.skills))
    throw new Error(`Unbekannte Fertigkeit ${key}. Erlaubt: ${Object.keys(dnd.skills).join(', ')}`);
  if (!isSkill && !(key in dnd.abilities))
    throw new Error(
      `Unbekanntes Attribut ${key}. Erlaubt: ${Object.keys(dnd.abilities).join(', ')}`
    );

  const scene = resolveScene(data.sceneIdentifier);
  const entries = resolveTargets(scene, data.targets, { allMatches: true, actorFallback: true });
  const config = {
    advantage: data.advantageMode === 'advantage',
    disadvantage: data.advantageMode === 'disadvantage',
  };
  const dialog = { configure: false };
  const message = { rollMode, create: toChat };
  const results = [];
  for (const e of entries) {
    const a = e.actor;
    if (data.rollType === 'passive') {
      results.push({ name: e.name, passive: a.system?.skills?.[key]?.passive ?? null });
      continue;
    }
    let rolls: any;
    if (data.rollType === 'skill')
      rolls = await a.rollSkill({ ...config, skill: key }, dialog, message);
    else if (data.rollType === 'save')
      rolls = await a.rollSavingThrow({ ...config, ability: key }, dialog, message);
    else rolls = await a.rollAbilityCheck({ ...config, ability: key }, dialog, message);
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    results.push({ name: e.name, total: roll?.total ?? null, natural: natural(roll) });
  }
  return { success: true, rollType: data.rollType, key, results };
}

// ══════════ Zufallstabellen ══════════

async function tableEntries(search?: string) {
  const out: { name: string; id: string; source: string }[] = [];
  const match = (name: string) => !search || name.toLowerCase().includes(search.toLowerCase());
  for (const t of g().tables)
    if (match(t.name)) out.push({ name: t.name, id: t.id, source: 'world' });
  for (const pack of g().packs) {
    if (pack.documentName !== 'RollTable') continue;
    const index = await pack.getIndex();
    for (const e of index) {
      if (match(e.name))
        out.push({
          name: e.name,
          id: `Compendium.${pack.collection}.RollTable.${e._id}`,
          source: pack.title,
        });
    }
  }
  return out;
}

export async function rollTable(data: any): Promise<any> {
  requireGM();
  if (data.action === 'list') {
    const tables = await tableEntries(data.search);
    return { success: true, count: tables.length, tables: tables.slice(0, 100) };
  }
  const ident = String(data.table ?? '');
  if (!ident) throw new Error('roll braucht table');
  let table = g().tables.get(ident) ?? g().tables.find((t: any) => ci(t.name, ident));
  if (!table && ident.includes('.')) table = await (globalThis as any).fromUuid(ident);
  if (!table) {
    const hits = (await tableEntries(ident)).filter(e => e.source !== 'world');
    const exact = hits.filter(h => ci(h.name, ident));
    const pick = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
    if (!pick) {
      throw new Error(
        hits.length
          ? `Mehrere Tabellen passen: ${hits
              .slice(0, 10)
              .map(h => `${h.name} (${h.id})`)
              .join('; ')}`
          : `Tabelle nicht gefunden: ${ident}`
      );
    }
    table = await (globalThis as any).fromUuid(pick.id);
  }
  const visibility = data.visibility ?? 'gm';
  const draw = await table.draw({
    rollMode: ROLL_MODES[visibility] ?? 'gmroll',
    displayChat: visibility !== 'none',
  });
  return {
    success: true,
    table: table.name,
    roll: draw.roll?.total ?? null,
    results: draw.results.map((r: any) => stripHtml(r.name || r.description || r.text)),
  };
}

// ══════════ Chat ══════════

export async function postChat(data: any): Promise<any> {
  requireGM();
  const ChatMessage = cfg().ChatMessage.documentClass;
  const styles = (globalThis as any).CONST.CHAT_MESSAGE_STYLES;
  let speaker: any = ChatMessage.getSpeaker({ user: g().user });
  if (data.speaker) {
    const scene = g().scenes.active ?? g().scenes.viewed;
    const token = scene?.tokens.find(
      (t: any) => ci(t.name, data.speaker) || ci(t.actor?.name, data.speaker)
    );
    const actor = token ? null : g().actors.find((a: any) => ci(a.name, data.speaker));
    speaker = token
      ? ChatMessage.getSpeaker({ token })
      : actor
        ? ChatMessage.getSpeaker({ actor })
        : { alias: data.speaker };
  }
  const whisper: string[] = [];
  for (const w of data.whisperTo ?? []) {
    const user = g().users.find((u: any) => ci(u.name, w) || ci(u.character?.name, w));
    if (!user) throw new Error(`Spieler nicht gefunden: ${w}`);
    whisper.push(user.id);
  }
  const style = styles[(data.style ?? (data.speaker ? 'ic' : 'ooc')).toUpperCase()];
  const content = /<[a-z][\s\S]*>/i.test(data.content)
    ? data.content
    : `<p>${data.content.replace(/\n/g, '<br>')}</p>`;
  const msg = await ChatMessage.create({ content, speaker, whisper, style });
  return {
    success: true,
    id: msg.id,
    speaker: speaker.alias ?? null,
    whisperTo: whisper.map(id => g().users.get(id)?.name),
  };
}

// ══════════ Makros ══════════

export async function runMacro(data: any): Promise<any> {
  requireGM();
  const macros = g().macros;
  if (data.action === 'list') {
    const s = data.search?.toLowerCase();
    return {
      success: true,
      macros: macros
        .filter((m: any) => !s || m.name.toLowerCase().includes(s))
        .map((m: any) => ({ name: m.name, id: m.id, type: m.type })),
    };
  }
  const ident = String(data.macro ?? '');
  const matches = macros.filter((m: any) => m.id === ident || ci(m.name, ident));
  if (!matches.length) throw new Error(`Makro nicht gefunden: ${ident}`);
  if (matches.length > 1)
    throw new Error(`Mehrere Makros heißen ${ident}: ${matches.map((m: any) => m.id).join(', ')}`);
  const result = await matches[0].execute();
  let safe: unknown = null;
  try {
    safe = result === undefined ? null : JSON.parse(JSON.stringify(result));
  } catch {
    safe = String(result);
  }
  return { success: true, macro: matches[0].name, result: safe };
}

// ══════════ Ansicht: Ping, Spieler holen, Nebel, Wetter ══════════

export async function sceneView(data: any): Promise<any> {
  requireGM();
  if (data.action === 'list-weather') {
    const effects = cfg().weatherEffects ?? {};
    return {
      success: true,
      weather: Object.entries<any>(effects).map(([id, e]) => ({
        id,
        name: g().i18n.localize(e.label ?? id),
      })),
    };
  }
  if (data.action === 'weather') {
    const scene = resolveScene(data.sceneIdentifier);
    const weather = data.weather ?? '';
    if (weather && !(weather in (cfg().weatherEffects ?? {}))) {
      throw new Error(`Unbekanntes Wetter ${weather}. list-weather zeigt die Auswahl.`);
    }
    await scene.update({ weather });
    return { success: true, scene: scene.name, weather };
  }

  const canvas = (globalThis as any).canvas;
  const scene = canvas?.scene;
  if (!scene) throw new Error('Der GM-Browser zeigt gerade keine Szene');
  if (
    data.sceneIdentifier &&
    scene.id !== data.sceneIdentifier &&
    !ci(scene.name, data.sceneIdentifier)
  ) {
    throw new Error(
      `Die GM-Ansicht zeigt ${scene.name}; erst dorthin wechseln (switch-scene mode view)`
    );
  }

  if (data.action === 'reset-fog') {
    await canvas.fog.reset();
    return { success: true, scene: scene.name, fog: 'reset' };
  }

  let point: { x: number; y: number };
  if (data.target) {
    const [t] = resolveTargets(scene, [data.target]);
    const size = scene.grid.size;
    point = t.token.object?.center ?? {
      x: t.token.x + (t.token.width * size) / 2,
      y: t.token.y + (t.token.height * size) / 2,
    };
  } else if (typeof data.x === 'number' && typeof data.y === 'number') {
    point = { x: data.x, y: data.y };
  } else {
    throw new Error(`${data.action} braucht target oder x/y`);
  }
  const pull = data.action === 'pull-players';
  const types = cfg().Canvas.pings.types;
  const ok = await canvas.ping(point, { pull, style: pull ? types.PULL : types.PULSE });
  if (ok === false) throw new Error('Punkt liegt außerhalb der Szene');
  return { success: true, scene: scene.name, point, pull };
}

// ══════════ Kreaturen-Karte ══════════

const signed = (n: number) => (n >= 0 ? `+${n}` : String(n));

/** Kompakter Werteblock mit abgeleiteten Werten (Trefferbonus, Schaden, SG) für Token oder Actor. */
export async function creatureCard(data: any): Promise<any> {
  requireGM();
  let actor: any = null;
  let token: any = null;
  if (data.target) {
    const scene = resolveScene(data.sceneIdentifier);
    [{ token, actor }] = resolveTargets(scene, [data.target], { actorFallback: true });
  } else if (data.actor) {
    actor = g().actors.get(data.actor) ?? g().actors.find((a: any) => ci(a.name, data.actor));
    if (!actor && String(data.actor).includes('.'))
      actor = await (globalThis as any).fromUuid(data.actor);
  }
  if (!actor) throw new Error('target (Token) oder actor (Name, ID, UUID) angeben');

  const dnd = cfg().DND5E;
  const sys = actor.system ?? {};
  const attr = sys.attributes ?? {};
  const label = (map: any, key: string) => g().i18n.localize(map?.[key]?.label ?? key);
  const traitList = (t: any, map: any) => {
    if (!t) return [];
    const vals = [...(t.value ?? [])].map((k: string) => label(map, k));
    if (t.custom) vals.push(t.custom);
    return vals;
  };

  const abilities: Record<string, string> = {};
  const saves: string[] = [];
  for (const [k, a] of Object.entries<any>(sys.abilities ?? {})) {
    abilities[k] = `${a.value} (${signed(a.mod)})`;
    if (a.proficient) saves.push(`${k} ${signed(a.save?.value ?? a.save ?? a.mod)}`);
  }
  const skills = Object.entries<any>(sys.skills ?? {})
    .filter(([, s]) => s.proficient)
    .map(([k, s]) => `${label(dnd.skills, k)} ${signed(s.total)}`);
  const movement = ['walk', 'fly', 'swim', 'climb', 'burrow']
    .filter(k => Number(attr.movement?.[k]) > 0)
    .map(k => `${k} ${attr.movement[k]}${k === 'fly' && attr.movement.hover ? ' (hover)' : ''}`);
  const senses = Object.entries<any>(attr.senses?.ranges ?? attr.senses ?? {})
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(([k, v]) => `${k} ${v}`);

  const actions = [];
  const traits = [];
  for (const item of actor.items) {
    const activities = [...(item.system?.activities ?? [])].filter((act: any) => !act.isHidden);
    const activation = activities[0]?.activation?.type ?? item.system?.activation?.type ?? '';
    const uses = item.system?.uses;
    const recharge = uses?.recovery?.find((r: any) => r.period === 'recharge');
    const usesText = recharge
      ? `Aufladen ${recharge.formula}${recharge.formula === '6' ? '' : '–6'}${uses.value ? '' : ' (leer)'}`
      : uses?.max > 0
        ? `${uses.value}/${uses.max}`
        : '';
    if (!activities.length || !activation || item.type === 'spell') {
      if (item.type === 'feat') traits.push(item.name);
      continue;
    }
    const parts = activities.map((act: any) => {
      const bits: string[] = [];
      if (act.labels?.toHit) bits.push(`${act.labels.toHit} zum Treffen`);
      if (act.labels?.save) bits.push(act.labels.save);
      const dmg = (act.labels?.damage ?? []).map((d: any) => d.label ?? d.formula).filter(Boolean);
      if (dmg.length) bits.push(dmg.join(' + '));
      return bits.join(', ');
    });
    actions.push({
      name: item.name,
      activation,
      cost: activities[0]?.activation?.value ?? null,
      text: parts.filter(Boolean).join(' | ') || null,
      uses: usesText || null,
      range: item.labels?.range ?? null,
    });
  }
  const spells = actor.items
    .filter((i: any) => i.type === 'spell')
    .map((i: any) => (i.system.level ? `${i.name} (${i.system.level})` : i.name));

  return {
    success: true,
    name: token?.name ?? actor.name,
    tokenId: token?.id ?? null,
    type: actor.type,
    cr: sys.details?.cr ?? null,
    creatureType: sys.details?.type?.label ?? sys.details?.type?.value ?? null,
    hp: hpOf(actor),
    ac: attr.ac?.value ?? null,
    initiative: attr.init?.total ?? null,
    movement,
    abilities,
    saves,
    skills,
    passivePerception: sys.skills?.prc?.passive ?? null,
    senses,
    resistances: traitList(sys.traits?.dr, dnd.damageTypes),
    immunities: traitList(sys.traits?.di, dnd.damageTypes),
    vulnerabilities: traitList(sys.traits?.dv, dnd.damageTypes),
    conditionImmunities: traitList(sys.traits?.ci, dnd.conditionTypes),
    languages: traitList(sys.traits?.languages, null),
    legendary: sys.resources?.legact?.max
      ? `${sys.resources.legact.value}/${sys.resources.legact.max}`
      : null,
    spellDC: attr.spell?.dc ?? null,
    spells,
    traits,
    actions,
    conditions: [...(actor.statuses ?? [])].map(statusName),
  };
}

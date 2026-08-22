#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function normalizeDay(value) {
  const lowered = String(value || '').trim().toLowerCase();
  const aliases = {
    miercoles: 'miércoles',
    sabado: 'sábado',
  };
  return aliases[lowered] || lowered;
}

function weekBucket(dayOfMonth) {
  if (dayOfMonth >= 1 && dayOfMonth <= 8) return 1;
  if (dayOfMonth >= 9 && dayOfMonth <= 16) return 2;
  if (dayOfMonth >= 17 && dayOfMonth <= 24) return 3;
  return 4;
}

function nowInTimezone(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'long',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const englishWeekday = (byType.weekday || '').toLowerCase();
  const weekdayMap = {
    monday: 'lunes',
    tuesday: 'martes',
    wednesday: 'miércoles',
    thursday: 'jueves',
    friday: 'viernes',
    saturday: 'sábado',
    sunday: 'domingo',
  };

  return {
    isoLocal: `${byType.year}-${byType.month}-${byType.day}T${byType.hour}:${byType.minute}:${byType.second}`,
    dayOfMonth: Number(byType.day),
    weekday: weekdayMap[englishWeekday] || englishWeekday,
  };
}

function normalizePhone(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  digits = digits.replace(/^0+/, '');
  if (digits.length === 10 && digits.startsWith('3')) {
    digits = `57${digits}`;
  }
  if (digits.length === 12 && digits.startsWith('57') && digits[2] === '3') {
    return digits;
  }
  return digits || null;
}

function appendLog(logPath, payload) {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(payload, null, 0)}\n`, 'utf8');
}

function loadContacts(contactsPath) {
  return JSON.parse(fs.readFileSync(contactsPath, 'utf8'));
}

function buildCampaign(data, timezone, forcedDay) {
  const now = nowInTimezone(timezone);
  const selectedDay = forcedDay ? normalizeDay(forcedDay) : now.weekday;
  const mensajesPorDia = data.mensajes_por_dia || {};
  const promocionesPorSemana = data.promociones_por_semana || {};
  const selectedWeekBucket = weekBucket(now.dayOfMonth);
  const promotion = promocionesPorSemana[String(selectedWeekBucket)] || promocionesPorSemana[selectedWeekBucket] || '';
  const rawContacts = Array.isArray(mensajesPorDia[selectedDay]) ? mensajesPorDia[selectedDay] : [];

  const contacts = rawContacts
    .filter((item) => Array.isArray(item) && item.length >= 2)
    .map((item) => ({
      phone: normalizePhone(item[0]),
      originalPhone: item[0],
      message: String(item[1] || '').trim(),
      raw: item,
    }))
    .filter((item) => item.phone && item.message);

  return {
    timezone,
    generated_at: now.isoLocal,
    system_day: now.weekday,
    selected_day: selectedDay,
    day_matches_system: selectedDay === now.weekday,
    selected_week_bucket: selectedWeekBucket,
    promotion,
    contact_count: contacts.length,
    contacts,
  };
}

function composeMessage(baseMessage, promotion) {
  const cleanBase = String(baseMessage || '').trim();
  const cleanPromotion = String(promotion || '').trim();
  if (!cleanPromotion) return cleanBase;
  if (!cleanBase) return cleanPromotion;
  return `${cleanBase}\n\n${cleanPromotion}`;
}

async function sendMessage({ baseUrl, instanceName, instanceToken, number, text }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/message/sendText/${instanceName}`, {
    method: 'POST',
    headers: {
      apikey: instanceToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      number,
      text,
    }),
  });

  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw };
  }

  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const contactsPath = path.resolve(String(args['contacts-path'] || ''));
  const timezone = String(args.timezone || 'America/Bogota');
  const forcedDay = args['force-day'] ? String(args['force-day']) : '';
  const dryRun = Boolean(args['dry-run']);
  const logPath = args['log-path'] ? path.resolve(String(args['log-path'])) : '';
  const outputPath = args['output-path'] ? path.resolve(String(args['output-path'])) : '';
  const delayMs = Number(args['delay-ms'] || 1200);
  const maxMessages = args.limit ? Number(args.limit) : 0;
  const baseUrl = String(args['evolution-base-url'] || '');
  const instanceName = String(args['instance-name'] || '');
  const instanceToken = String(args['instance-token'] || '');

  if (!contactsPath || !fs.existsSync(contactsPath)) {
    console.log(JSON.stringify({ ok: false, error: `No existe el archivo de contactos: ${contactsPath}` }, null, 2));
    process.exit(1);
  }

  let data;
  let campaign;
  try {
    data = loadContacts(contactsPath);
    campaign = buildCampaign(data, timezone, forcedDay);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error.message || error) }, null, 2));
    process.exit(1);
  }

  const basePayload = {
    ok: true,
    mode: dryRun ? 'dry-run' : 'send',
    transport_ready: Boolean(baseUrl && instanceName && instanceToken),
    ...campaign,
  };

  if (!campaign.day_matches_system && !forcedDay) {
    const payload = {
      ...basePayload,
      ok: false,
      error: `El día calculado (${campaign.selected_day}) no coincide con el día del sistema (${campaign.system_day}).`,
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  const selectedContacts = maxMessages > 0 ? campaign.contacts.slice(0, maxMessages) : campaign.contacts;

  if (dryRun || !selectedContacts.length) {
    const payload = {
      ...basePayload,
      contacts: selectedContacts,
      send_results: [],
      sent_count: 0,
      failed_count: 0,
      skipped_count: campaign.contact_count - selectedContacts.length,
    };
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!baseUrl || !instanceName || !instanceToken) {
    console.log(JSON.stringify({ ...basePayload, ok: false, error: 'Faltan parámetros de transporte para Evolution API.' }, null, 2));
    process.exit(1);
  }

  const sendResults = [];
  let sentCount = 0;
  let failedCount = 0;

  for (let index = 0; index < selectedContacts.length; index += 1) {
    const contact = selectedContacts[index];
    const text = composeMessage(contact.message, campaign.promotion);
    const attempt = await sendMessage({
      baseUrl,
      instanceName,
      instanceToken,
      number: contact.phone,
      text,
    });

    const result = {
      index,
      phone: contact.phone,
      status: attempt.status,
      ok: attempt.ok,
      remoteJid: attempt.body?.key?.remoteJid || null,
      messageId: attempt.body?.key?.id || null,
    };
    sendResults.push(result);

    appendLog(logPath, {
      timestamp: new Date().toISOString(),
      selected_day: campaign.selected_day,
      phone: contact.phone,
      ok: attempt.ok,
      status: attempt.status,
      messageId: result.messageId,
    });

    if (attempt.ok) {
      sentCount += 1;
    } else {
      failedCount += 1;
    }

    if (index < selectedContacts.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const payload = {
    ...basePayload,
    contacts: selectedContacts,
    send_results: sendResults,
    sent_count: sentCount,
    failed_count: failedCount,
    skipped_count: campaign.contact_count - selectedContacts.length,
  };

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: String(error.message || error) }, null, 2));
  process.exit(1);
});

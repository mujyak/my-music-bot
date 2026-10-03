const introSessions = new Map(); // guildId -> session

export function getIntroSession(guildId) {
  return introSessions.get(guildId) ?? null;
}

export function setIntroSession(guildId, session) {
  introSessions.set(guildId, session);
  return session;
}

export function clearIntroSession(guildId) {
  const session = introSessions.get(guildId) ?? null;
  introSessions.delete(guildId);
  return session;
}

export function isIntroActive(guildId) {
  return introSessions.has(guildId);
}
/**
 * Recognize explicit non-acting credit labels without interpreting character names or absent roles.
 * Mixed acting/non-acting credits remain in Stars; parenthetical annotations preserve the role label.
 */
export function isNonActingRole(role: string | null): boolean {
	if (!role?.trim()) {
		return false;
	}
	return role.split(/\s*\/\s*/).every(part => /^(?:self|himself|herself|themselves|themself|host|co[- ]?host|presenter|narrator|interviewee)(?:\s*\([^)]*\))*\s*$/i.test(part.trim())
		|| /^(?:self|himself|herself|themselves|themself)\s*[-–—:]\s*\S/i.test(part.trim()));
}

/** Explicit production jobs; character names and unknown roles are not inferred to be crew. */
const crewRoles = new Set([
	'director', 'assistant director', 'first assistant director', 'second assistant director',
	'producer', 'executive producer', 'co-executive producer', 'co-producer', 'associate producer',
	'consulting producer', 'supervising producer', 'line producer', 'production manager',
	'writer', 'screenwriter', 'screenplay', 'story', 'creator', 'showrunner',
	'composer', 'music', 'original music composer', 'music supervisor',
	'cinematographer', 'cinematography', 'director of photography', 'camera operator',
	'editor', 'film editor', 'assistant editor', 'casting director', 'casting',
	'production designer', 'production design', 'art director', 'art direction', 'set decorator',
	'costume designer', 'costume design', 'makeup artist', 'make-up artist', 'hair stylist',
	'sound designer', 'sound design', 'sound editor', 'sound mixer', 're-recording mixer',
	'visual effects supervisor', 'special effects supervisor', 'stunt coordinator', 'choreographer',
]);

/** Recognize explicit crew jobs, including multiple jobs and parenthetical credit annotations. */
export function isCrewRole(role: string | null): boolean {
	if (!role?.trim()) {
		return false;
	}
	return role.split(/\s*\/\s*/).every(part => crewRoles.has(part.replace(/\s*\([^)]*\)/g, '').trim().toLowerCase()));
}

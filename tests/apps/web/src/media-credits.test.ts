import { expect, it } from 'vitest';
import { isCrewRole, isNonActingRole } from '../../../../apps/web/src/media-credits';

it.each(['Self', 'Himself', 'Herself (archive footage)', 'Themselves', 'Host', 'Co-host', 'Presenter', 'Narrator', 'Interviewee', 'SELF / Host', 'Self - Guest', 'Self (voice)'])('separates the explicit non-acting role %s', role => {
	expect(isNonActingRole(role)).toBe(true);
});
it.each([null, '', ' ', 'John Smith', 'Selfridge', 'Hostile Stranger', 'The Narrator', 'Character (voice)', 'Self / John Smith', 'Producer'])('retains an absent, acting, mixed, or unrecognized role %s in Stars', role => {
	expect(isNonActingRole(role)).toBe(false);
});


it.each(['Executive Producer', 'Producer', 'Director', 'Writer', 'Director of Photography', 'Executive Producer (uncredited)', 'Producer / Director', 'Costume Designer'])('places the production role %s in Crew', role => {
	expect(isCrewRole(role)).toBe(true);
});
it.each([null, '', 'Self', 'Host', 'Narrator', 'The Producer', 'Director Smith', 'Producer / John Smith'])('does not infer crew from %s', role => {
	expect(isCrewRole(role)).toBe(false);
});

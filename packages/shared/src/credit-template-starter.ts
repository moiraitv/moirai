/** Editable Liquid/ASS music-video credits with fixed opening and closing cues. */
export const MUSIC_VIDEO_CREDIT_TEMPLATE = `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None
PlayResX: {{ resolution.width }}
PlayResY: {{ resolution.height }}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Neue Kabel Black,{{ resolution.height | divided_by: 10.0 | round }},&H00DDDDDD,&H00DDDDDD,&H00444444,&H00000000,0,0,0,0,100,100,0,0,1,1,3,1,10,10,10,1
Style: Artist,Neue Kabel,{{ resolution.height | divided_by: 20.0 | round }},&H00FFFFFF,&H00FFFFFF,&H00444444,&H00000000,1,0,0,0,100,100,0,0,1,1,3,1,10,10,10,1
Style: Album,Neue Kabel Book,{{ resolution.height | divided_by: 20.0 | round }},&H00DDDDDD,&H00DDDDDD,&H00444444,&H00000000,0,0,0,0,100,100,0,0,1,1,3,1,10,10,40,1
Style: Studio,Courier Prime,{{ resolution.height | divided_by: 35.0 | round }},&H00A0A0A0,&H00A0A0A0,&H00444444,&H00000000,0,0,0,0,100,100,1,0,1,1,3,1,10,10,10,1
Style: Director,Courier Prime,{{ resolution.height | divided_by: 35.0 | round }},&H00DDDDDD,&H00DDDDDD,&H00444444,&H00000000,0,0,0,0,100,100,1,0,1,1,3,1,10,10,10,1

[Events]
{% assign margin_x = resolution.width | times: 0.03 | round %}
{% assign margin_y = resolution.height | times: 0.05 | round %}
{% assign artist_y = resolution.height | times: 0.17 | round %}
{% assign album_y = resolution.height | times: 0.23 | round %}
{% assign studio_y = resolution.height | times: 0.29 | round %}
{% assign director_y = resolution.height | times: 0.33 | round %}
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
{% for interval in (1..2) %}
{% if interval == 1 %}
{% assign start = 7 %}{% assign finish = 17 %}
{% assign enabled = false %}{% if duration.total_seconds > 60 %}{% assign enabled = true %}{% endif %}
{% else %}
{% assign start = duration.total_seconds | minus: 15 | at_least: 0 %}
{% assign finish = duration.total_seconds | minus: 5 | at_least: 0 %}
{% assign enabled = false %}{% if finish > start %}{% assign enabled = true %}{% endif %}
{% endif %}
{% if enabled %}
Dialogue: 0,{{ start | ass_time }},{{ finish | ass_time }},Title,,{{ margin_x }},{{ margin_x }},{{ margin_y }},,{\\fad(1800,1200)}{{ title }}
Dialogue: 0,{{ start | ass_time }},{{ finish | ass_time }},Artist,,{{ margin_x }},{{ margin_x }},{{ artist_y }},,{\\fad(1200,1800)}{{ all_artists | uniq | join: " | " }}
{% if album != "" %}
Dialogue: 0,{{ start | ass_time }},{{ finish | ass_time }},Album,,{{ margin_x }},{{ margin_x }},{{ album_y }},,{\\fad(1200,1800)}{{ album }}{% if release_date %} ({{ release_date.year }}){% endif %}
{% endif %}
{% if studios.size > 0 %}
Dialogue: 0,{{ start | ass_time }},{{ finish | ass_time }},Studio,,{{ margin_x }},{{ margin_x }},{{ studio_y }},,{\\fad(1200,1800)}{{ studios | uniq | join: " | " }}
{% endif %}
{% if directors.size > 0 %}
Dialogue: 0,{{ start | ass_time }},{{ finish | ass_time }},Director,,{{ margin_x }},{{ margin_x }},{{ director_y }},,{\\fad(1200,1800)}Director: {{ directors | uniq | join: " | " }}
{% endif %}
{% endif %}
{% endfor %}
`;

/** Stable identity and presentation for the protected music-video credit design. */
export const BUILTIN_CREDIT_TEMPLATE = {
	id: '20000000-0000-4000-8000-000000000001',
	name: 'Music-video credits',
	description: 'Artist, song, and album credits at the beginning and end of music videos.',
	source: MUSIC_VIDEO_CREDIT_TEMPLATE,
};

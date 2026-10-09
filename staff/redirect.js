// 以前の事務所内ページの URL（forms.html・site.html）から、1つにまとめた事務所内ページ（/staff/#…）へ移す
const params = new URLSearchParams(location.search);
const kind = params.get('kind');
const code = params.get('code');
let page = 'forms';
if (location.pathname.endsWith('site.html')) page = 'site';
else if (kind === 'office' || kind === 'register') page = kind;
location.replace(`/staff/#${page}${page === 'register' && code ? `/${encodeURIComponent(code)}` : ''}`);

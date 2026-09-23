// Body uniquement si présent : les GET ne doivent PAS avoir de Content-Type/body
if (data !== undefined && data !== null) {
  config.headers['Content-Type'] = 'application/json';
  config.data = data;
}

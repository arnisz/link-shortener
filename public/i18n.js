const TRANSLATIONS = {
  en: {
    // ── Landing page ────────────────────────────────────────────────────────────
    'page.title':          'aadd.li – Link Shortener',
    'page.description':    'Free URL shortener with expiring links. No sign-up required. Shorten links instantly for privacy and ease of use.',
    'brand':               'aadd.li',
    'hero.title':          'Free URL Shortener with Expiring Links',
    'hero.subline':        'Shorten long URLs instantly. No registration required. Links expire automatically after 48h.',
    'form.placeholder':    'https://example.com/long-link',
    'form.arialabel':      'Enter long URL',
    'form.submit':         'Shorten link',
    'form.example':        'Example: example.com/very/long/link → aadd.li/r/abc12',
    'result.copy':         'Copy',
    'result.copied':       'Copied!',
    'result.expires':      'This link expires in 48 hours.',
    'result.cta_text':     'Save permanently?',
    'result.cta_link':     'Sign in now →',
    'location.button':     'Share my location as link',
    'location.hint':       'Creates a short link to your current GPS location.',
    'location.detecting':  'Detecting location…',
    'location.denied':     'Location access denied. Please grant permission in app settings.',
    'login.button':        'Sign in with Google',
    'login.hint':          'Optional for managing and reusing links.',
    'error.spam':          'This URL was detected as spam and cannot be shortened.',
    'error.ratelimit':     'Too many requests. Please wait a minute.',
    'error.generic':       'An error occurred. Please try again.',
    'error.network':       'Network error. Please try again.',
    'footer.impressum':    'Imprint',
    'footer.privacy':      'Privacy',

    // ── SEO Content ─────────────────────────────────────────────────────────────
    'seo.title':          'Free URL Shortener with Expiring Links',
    'seo.p1':             'aadd.li is a fast and simple URL shortener designed for privacy and ease of use. Create short links instantly without the need for an account.',
    'seo.p2':             'Unlike other services, our anonymous links expire automatically after 48 hours, keeping the web clean. For permanent links and custom aliases, you can optionally sign in with your Google account.',
    'seo.features.title': 'Why use aadd.li?',
    'seo.features.1':     'Create short links instantly',
    'seo.features.2':     'Links expire automatically (48h default)',
    'seo.features.3':     'Optional login for custom aliases and management',
    'seo.features.4':     'No unnecessary overhead or tracking',

    // ── App page ─────────────────────────────────────────────────────────────────
    'app.page.title':                  'aadd.li – App',
    'app.logout':                      'Sign out',
    'app.loggedin':                    'Signed in as',
    'app.notloggedin':                 'Not signed in.',
    'app.load.error':                  'Error loading:',
    'app.create.title':                'Shorten new link',
    'app.create.url':                  'Target URL *',
    'app.create.url.placeholder':      'https://example.com/very/long/path',
    'app.create.title_field':          'Title (optional)',
    'app.create.title_field.placeholder': 'My Link',
    'app.create.alias':                'Alias (optional)',
    'app.create.alias.placeholder':    'my-link',
    'app.create.alias.title':          '3–50 characters: letters (a–z, A–Z), digits, hyphen (-), underscore (_). Other dashes are normalized.',
    'app.create.expires':              'Expiry date (optional)',
    'app.create.submit':               'Create',
    'app.create.submitting':           'Creating…',
    'app.create.success_prefix':       '✓ Link created: {url}',
    'app.links.title':                 'My Links',
    'app.links.loading':               'Loading…',
    'app.links.empty':                 'No links yet – create your first!',
    'app.links.all_loaded':            'All links loaded',
    'app.links.load.error':            'Error loading links.',
    'app.links.load.more.error':       'Error loading more links.',
    'app.link.click':                  'Click',
    'app.link.clicks':                 'Clicks',
    'app.link.created':                'Created:',
    'app.link.expires':                'Expires:',
    'app.link.badge.active':           'Active',
    'app.link.badge.inactive':         'Inactive',
    'app.link.badge.expired':          'Expired',
    'app.link.btn.copy':               'Copy',
    'app.link.btn.copied':             'Copied!',
    'app.link.btn.edit':               'Edit',
    'app.link.btn.save':               'Save',
    'app.link.btn.cancel':             'Cancel',
    'app.link.btn.deactivate':         'Deactivate',
    'app.link.btn.activate':           'Activate',
    'app.link.btn.delete':             'Delete',
    'app.link.edit.alias':             'Alias',
    'app.link.edit.alias.warning':     'Changing the alias will permanently break the existing short URL. Anyone using the old link will get a 404 error. Continue?',
    'app.location.button':             'Save location as link',
    'app.location.detecting':          'Detecting location…',
    'app.location.title_prefix':       'My location –',
    'app.location.denied':             'Location access denied.',
    'app.session.expired':             'Session expired.',
    'app.session.relogin':             'Please sign in again.',
    'error.app.create':                'Could not create link.',
    'error.app.toggle':                'Could not update link.',
    'error.app.delete':                'Could not delete link.',
  },

  de: {
    // ── Landing page ────────────────────────────────────────────────────────────
    'page.title':          'aadd.li – dein Link-Kürzer',
    'page.description':    'Kostenloser Link-Kürzer mit ablaufenden Links. Ohne Anmeldung. URLs sofort und datenschutzfreundlich kürzen.',
    'brand':               'aadd.li',
    'hero.title':          'Link-Kürzer mit ablaufenden Links',
    'hero.subline':        'Kürze lange URLs sofort. Ohne Anmeldung. Anonyme Links laufen automatisch nach 48h ab.',
    'form.placeholder':    'https://example.com/langer-link',
    'form.arialabel':      'Lange URL eingeben',
    'form.submit':         'Link kürzen',
    'form.example':        'Beispiel: example.com/very/long/link → aadd.li/r/abc12',
    'result.copy':         'Kopieren',
    'result.copied':       'Kopiert!',
    'result.expires':      'Dieser Link läuft in 48 Stunden ab.',
    'result.cta_text':     'Dauerhaft speichern?',
    'result.cta_link':     'Jetzt anmelden →',
    'location.button':     'Standort als Kurzlink teilen',
    'location.hint':       'Erstellt einen Kurzlink zu deinem aktuellen GPS-Standort.',
    'location.detecting':  'Standort wird ermittelt…',
    'location.denied':     'Standortzugriff verweigert. Bitte Berechtigung in den App-Einstellungen erteilen.',
    'login.button':        'Mit Google anmelden',
    'login.hint':          'Optional für Komfortfunktionen wie Verwalten und Wiederverwenden.',
    'error.spam':          'Diese URL wurde als Spam erkannt und kann nicht gekürzt werden.',
    'error.ratelimit':     'Zu viele Anfragen. Bitte warte eine Minute.',
    'error.generic':       'Ein Fehler ist aufgetreten. Bitte versuche es erneut.',
    'error.network':       'Netzwerkfehler. Bitte versuche es erneut.',
    'footer.impressum':    'Impressum',
    'footer.privacy':      'Datenschutz',

    // ── SEO Content ─────────────────────────────────────────────────────────────
    'seo.title':          'Kostenloser Link-Kürzer mit ablaufenden Links',
    'seo.p1':             'aadd.li ist ein schneller und einfacher URL-Shortener, der auf Datenschutz und Benutzerfreundlichkeit ausgelegt ist. Erstellen Sie sofort Kurzlinks, ohne ein Konto erstellen zu müssen.',
    'seo.p2':             'Im Gegensatz zu anderen Diensten laufen unsere anonymen Links automatisch nach 48 Stunden ab. Für dauerhafte Links und eigene Aliase können Sie sich optional mit Ihrem Google-Konto anmelden.',
    'seo.features.title': 'Warum aadd.li nutzen?',
    'seo.features.1':     'Links sofort erstellen',
    'seo.features.2':     'Links laufen automatisch ab (Standard 48h)',
    'seo.features.3':     'Optionaler Login für eigene Aliase und Verwaltung',
    'seo.features.4':     'Kein unnötiger Ballast oder Tracking',

    // ── App page ─────────────────────────────────────────────────────────────────
    'app.page.title':                  'aadd.li – Link-Kürzer',
    'app.logout':                      'Abmelden',
    'app.loggedin':                    'Eingeloggt als',
    'app.notloggedin':                 'Nicht eingeloggt.',
    'app.load.error':                  'Fehler beim Laden:',
    'app.create.title':                'Neuen Link kürzen',
    'app.create.url':                  'Ziel-URL *',
    'app.create.url.placeholder':      'https://example.com/sehr/langer/pfad',
    'app.create.title_field':          'Titel (optional)',
    'app.create.title_field.placeholder': 'Mein Link',
    'app.create.alias':                'Alias (optional)',
    'app.create.alias.placeholder':    'mein-link',
    'app.create.alias.title':          '3–50 Zeichen: Buchstaben (a–z, A–Z), Ziffern, Bindestrich (-), Unterstrich (_). Andere Bindestriche werden normalisiert.',
    'app.create.expires':              'Ablaufdatum (optional)',
    'app.create.submit':               'Erstellen',
    'app.create.submitting':           'Erstelle…',
    'app.create.success_prefix':       '✓ Erstellt: {url}',
    'app.links.title':                 'Meine Links',
    'app.links.loading':               'Lade…',
    'app.links.empty':                 'Noch keine Links – erstelle deinen ersten!',
    'app.links.all_loaded':            'Alle Links geladen',
    'app.links.load.error':            'Fehler beim Laden der Links.',
    'app.links.load.more.error':       'Fehler beim Laden weiterer Links.',
    'app.link.click':                  'Klick',
    'app.link.clicks':                 'Klicks',
    'app.link.created':                'Erstellt:',
    'app.link.expires':                'Läuft ab:',
    'app.link.badge.active':           'Aktiv',
    'app.link.badge.inactive':         'Inaktiv',
    'app.link.badge.expired':          'Abgelaufen',
    'app.link.btn.copy':               'Kopieren',
    'app.link.btn.copied':             'Kopiert!',
    'app.link.btn.edit':               'Bearbeiten',
    'app.link.btn.save':               'Speichern',
    'app.link.btn.cancel':             'Abbrechen',
    'app.link.btn.deactivate':         'Deaktivieren',
    'app.link.btn.activate':           'Aktivieren',
    'app.link.btn.delete':             'Löschen',
    'app.link.edit.alias':             'Alias',
    'app.link.edit.alias.warning':     'Das Ändern des Alias macht die bestehende Kurz-URL dauerhaft ungültig. Alle, die den alten Link verwenden, erhalten einen 404-Fehler. Fortfahren?',
    'app.location.button':             'Standort als Link speichern',
    'app.location.detecting':          'Standort wird ermittelt…',
    'app.location.title_prefix':       'Mein Standort –',
    'app.location.denied':             'Standortzugriff verweigert.',
    'app.session.expired':             'Sitzung abgelaufen.',
    'app.session.relogin':             'Bitte neu anmelden.',
    'error.app.create':                'Link konnte nicht erstellt werden.',
    'error.app.toggle':                'Link konnte nicht aktualisiert werden.',
    'error.app.delete':                'Link konnte nicht gelöscht werden.',
  },

  es: {
    // ── Landing page ────────────────────────────────────────────────────────────
    'page.title':          'aadd.li – Acortador de enlaces',
    'page.description':    'Acortador de URLs gratuito con caducidad. Sin registro. Acorta enlaces al instante para mayor privacidad.',
    'brand':               'aadd.li',
    'hero.title':          'Acortador de enlaces con caducidad',
    'hero.subline':        'Acorta URLs largas al instante. Sin registro. Los enlaces anónimos caducan automáticamente en 48h.',
    'form.placeholder':    'https://ejemplo.com/enlace-largo',
    'form.arialabel':      'Introduce la URL larga',
    'form.submit':         'Acortar enlace',
    'form.example':        'Ejemplo: ejemplo.com/muy/largo/enlace → aadd.li/r/abc12',
    'result.copy':         'Copiar',
    'result.copied':       '¡Copiado!',
    'result.expires':      'Este enlace caduca en 48 horas.',
    'result.cta_text':     '¿Guardar permanentemente?',
    'result.cta_link':     'Inicia sesión →',
    'location.button':     'Compartir mi ubicación como enlace',
    'location.hint':       'Crea un enlace corto a tu ubicación GPS actual.',
    'location.detecting':  'Detectando ubicación…',
    'location.denied':     'Acceso a ubicación denegado. Concede permiso en los ajustes de la app.',
    'login.button':        'Iniciar sesión con Google',
    'login.hint':          'Opcional para gestionar y reutilizar enlaces.',
    'error.spam':          'Esta URL fue detectada como spam y no puede acortarse.',
    'error.ratelimit':     'Demasiadas solicitudes. Espera un momento.',
    'error.generic':       'Ocurrió un error. Por favor, inténtalo de nuevo.',
    'error.network':       'Error de red. Por favor, inténtalo de nuevo.',
    'footer.impressum':    'Aviso legal',
    'footer.privacy':      'Privacidad',

    // ── SEO Content ─────────────────────────────────────────────────────────────
    'seo.title':          'Acortador de URLs gratuito con enlaces que caducan',
    'seo.p1':             'aadd.li es un acortador de URLs rápido y sencillo diseñado para la privacidad y la facilidad de uso. Crea enlaces cortos al instante sin necesidad de una cuenta.',
    'seo.p2':             'A diferencia de otros servicios, nuestros enlaces anónimos caducan automáticamente después de 48 horas. Para enlaces permanentes y alias personalizados, puedes iniciar sesión opcionalmente con tu cuenta de Google.',
    'seo.features.title': '¿Por qué usar aadd.li?',
    'seo.features.1':     'Crea enlaces cortos al instante',
    'seo.features.2':     'Los enlaces caducan automáticamente (48h por defecto)',
    'seo.features.3':     'Inicio de sesión opcional para alias personalizados y gestión',
    'seo.features.4':     'Sin sobrecarga innecesaria ni rastreo',

    // ── App page ─────────────────────────────────────────────────────────────────
    'app.page.title':                  'aadd.li – App',
    'app.logout':                      'Cerrar sesión',
    'app.loggedin':                    'Sesión iniciada como',
    'app.notloggedin':                 'No has iniciado sesión.',
    'app.load.error':                  'Error al cargar:',
    'app.create.title':                'Acortar nuevo enlace',
    'app.create.url':                  'URL de destino *',
    'app.create.url.placeholder':      'https://ejemplo.com/ruta/muy/larga',
    'app.create.title_field':          'Título (opcional)',
    'app.create.title_field.placeholder': 'Mi enlace',
    'app.create.alias':                'Alias (opcional)',
    'app.create.alias.placeholder':    'mi-enlace',
    'app.create.alias.title':          '3–50 caracteres: letras (a–z, A–Z), dígitos, guión (-), guión bajo (_). Otros guiones se normalizan.',
    'app.create.expires':              'Fecha de expiración (opcional)',
    'app.create.submit':               'Crear',
    'app.create.submitting':           'Creando…',
    'app.create.success_prefix':       '✓ Enlace creado: {url}',
    'app.links.title':                 'Mis enlaces',
    'app.links.loading':               'Cargando…',
    'app.links.empty':                 'Aún no hay enlaces – ¡crea el primero!',
    'app.links.all_loaded':            'Todos los enlaces cargados',
    'app.links.load.error':            'Error al cargar los enlaces.',
    'app.links.load.more.error':       'Error al cargar más enlaces.',
    'app.link.click':                  'clic',
    'app.link.clicks':                 'clics',
    'app.link.created':                'Creado:',
    'app.link.expires':                'Caduca:',
    'app.link.badge.active':           'Activo',
    'app.link.badge.inactive':         'Inactivo',
    'app.link.badge.expired':          'Caducado',
    'app.link.btn.copy':               'Copiar',
    'app.link.btn.copied':             '¡Copiado!',
    'app.link.btn.edit':               'Editar',
    'app.link.btn.save':               'Guardar',
    'app.link.btn.cancel':             'Cancelar',
    'app.link.btn.deactivate':         'Desactivar',
    'app.link.btn.activate':           'Activar',
    'app.link.btn.delete':             'Eliminar',
    'app.link.edit.alias':             'Alias',
    'app.link.edit.alias.warning':     'Cambiar el alias invalidará permanentemente la URL corta existente. Cualquiera que use el enlace antiguo recibirá un error 404. ¿Continuar?',
    'app.location.button':             'Guardar ubicación como enlace',
    'app.location.detecting':          'Detectando ubicación…',
    'app.location.title_prefix':       'Mi ubicación –',
    'app.location.denied':             'Acceso a ubicación denegado.',
    'app.session.expired':             'Sesión expirada.',
    'app.session.relogin':             'Por favor, inicia sesión de nuevo.',
    'error.app.create':                'No se pudo crear el enlace.',
    'error.app.toggle':                'No se pudo actualizar el enlace.',
    'error.app.delete':                'No se pudo eliminar el enlace.',
  },

  fr: {
    // ── Landing page ────────────────────────────────────────────────────────────
    'page.title':          'aadd.li – Raccourcisseur de liens',
    'page.description':    'Raccourcisseur d\'URL gratuit avec expiration. Sans inscription. Raccourcissez vos liens instantanément pour plus de confidentialité.',
    'brand':               'aadd.li',
    'hero.title':          'Raccourcisseur d\'URL gratuit avec expiration',
    'hero.subline':        'Raccourcissez vos URLs instantanément. Sans inscription. Liens anonymes expirent après 48h.',
    'form.placeholder':    'https://exemple.com/lien-long',
    'form.arialabel':      "Entrez l'URL longue",
    'form.submit':         'Raccourcir le lien',
    'form.example':        'Exemple : exemple.com/tres/long/lien → aadd.li/r/abc12',
    'result.copy':         'Copier',
    'result.copied':       'Copié !',
    'result.expires':      'Ce lien expire dans 48 heures.',
    'result.cta_text':     'Sauvegarder définitivement ?',
    'result.cta_link':     'Se connecter →',
    'location.button':     'Partager ma position en lien',
    'location.hint':       'Crée un lien court vers votre position GPS actuelle.',
    'location.detecting':  'Détection de la position…',
    'location.denied':     "Accès à la localisation refusé. Accordez la permission dans les paramètres de l'app.",
    'login.button':        'Se connecter avec Google',
    'login.hint':          'Facultatif pour gérer et réutiliser vos liens.',
    'error.spam':          'Cette URL a été détectée comme spam et ne peut pas être raccourcie.',
    'error.ratelimit':     'Trop de requêtes. Veuillez patienter une minute.',
    'error.generic':       "Une erreur s'est produite. Veuillez réessayer.",
    'error.network':       'Erreur réseau. Veuillez réessayer.',
    'footer.impressum':    'Mentions légales',
    'footer.privacy':      'Confidentialité',

    // ── SEO Content ─────────────────────────────────────────────────────────────
    'seo.title':          'Raccourcisseur d\'URL gratuit avec liens expirables',
    'seo.p1':             'aadd.li est un raccourcisseur d\'URL rapide et simple conçu pour la confidentialité et la facilité d\'utilisation. Créez des liens courts instantanément sans avoir besoin de compte.',
    'seo.p2':             'Contrairement à d\'autres services, nos liens anonymes expirent automatiquement après 48 heures. Pour des liens permanents et des alias personnalisés, vous pouvez facultativement vous connecter avec votre compte Google.',
    'seo.features.title': 'Pourquoi utiliser aadd.li ?',
    'seo.features.1':     'Créez des liens courts instantanément',
    'seo.features.2':     'Les liens expirent automatiquement (48h par défaut)',
    'seo.features.3':     'Connexion facultative pour les alias personnalisés et la gestion',
    'seo.features.4':     'Pas de surcharge inutile ni de suivi',

    // ── App page ─────────────────────────────────────────────────────────────────
    'app.page.title':                  'aadd.li – Application',
    'app.logout':                      'Se déconnecter',
    'app.loggedin':                    'Connecté en tant que',
    'app.notloggedin':                 'Non connecté.',
    'app.load.error':                  'Erreur de chargement :',
    'app.create.title':                'Raccourcir un nouveau lien',
    'app.create.url':                  'URL cible *',
    'app.create.url.placeholder':      'https://exemple.com/chemin/tres/long',
    'app.create.title_field':          'Titre (facultatif)',
    'app.create.title_field.placeholder': 'Mon lien',
    'app.create.alias':                'Alias (facultatif)',
    'app.create.alias.placeholder':    'mon-lien',
    'app.create.alias.title':          '3–50 caractères : lettres (a–z, A–Z), chiffres, tiret (-), underscore (_). Les autres tirets sont normalisés.',
    'app.create.expires':              "Date d'expiration (facultative)",
    'app.create.submit':               'Créer',
    'app.create.submitting':           'Création…',
    'app.create.success_prefix':       'Lien créé : {url}',
    'app.links.title':                 'Mes liens',
    'app.links.loading':               'Chargement…',
    'app.links.empty':                 "Aucun lien pour l'instant – créez le premier !",
    'app.links.all_loaded':            'Tous les liens chargés',
    'app.links.load.error':            'Erreur lors du chargement des liens.',
    'app.links.load.more.error':       "Erreur lors du chargement d'autres liens.",
    'app.link.click':                  'clic',
    'app.link.clicks':                 'clics',
    'app.link.created':                'Créé :',
    'app.link.expires':                'Expire :',
    'app.link.badge.active':           'Actif',
    'app.link.badge.inactive':         'Inactif',
    'app.link.badge.expired':          'Expiré',
    'app.link.btn.copy':               'Copier',
    'app.link.btn.copied':             'Copié !',
    'app.link.btn.edit':               'Modifier',
    'app.link.btn.save':               'Enregistrer',
    'app.link.btn.cancel':             'Annuler',
    'app.link.btn.deactivate':         'Désactiver',
    'app.link.btn.activate':           'Activer',
    'app.link.btn.delete':             'Supprimer',
    'app.link.edit.alias':             'Alias',
    'app.link.edit.alias.warning':     "Modifier l'alias invalidera définitivement l'URL courte existante. Toute personne utilisant l'ancien lien recevra une erreur 404. Continuer ?",
    'app.location.button':             'Enregistrer la position en lien',
    'app.location.detecting':          'Détection de la position…',
    'app.location.title_prefix':       'Ma position –',
    'app.location.denied':             'Accès à la localisation refusé.',
    'app.session.expired':             'Session expirée.',
    'app.session.relogin':             'Veuillez vous reconnecter.',
    'error.app.create':                'Impossible de créer le lien.',
    'error.app.toggle':                'Impossible de mettre à jour le lien.',
    'error.app.delete':                'Impossible de supprimer le lien.',
  },
};

// ── Core helpers ──────────────────────────────────────────────────────────────

const DEFAULT_LANG = 'de';
const STORAGE_KEY = 'lang';
const SUPPORTED_LANGS = Object.keys(TRANSLATIONS);
const LOCALE_MAP = { en: 'en-GB', de: 'de-DE', es: 'es-ES', fr: 'fr-FR' };

let currentLang = null;
let hasBoundLanguageSwitcher = false;

function safeStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures (private mode, blocked storage, etc.)
  }
}

function normalizeLang(lang) {
  if (!lang || typeof lang !== 'string') return null;

  const trimmed = lang.trim().toLowerCase();
  if (!trimmed) return null;
  if (SUPPORTED_LANGS.includes(trimmed)) return trimmed;

  const base = trimmed.split(/[-_]/)[0];
  return SUPPORTED_LANGS.includes(base) ? base : null;
}

function resolveInitialLang() {
  const saved = normalizeLang(safeStorageGet(STORAGE_KEY));
  if (saved) return saved;

  const htmlLang = normalizeLang(document.documentElement.lang);
  if (htmlLang) return htmlLang;

  const preferred = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language];

  for (const candidate of preferred) {
    const normalized = normalizeLang(candidate);
    if (normalized) return normalized;
  }

  return DEFAULT_LANG;
}

function getLang() {
  if (!currentLang) {
    currentLang = resolveInitialLang();
  }
  return currentLang;
}

function getLocale(lang = getLang()) {
  return LOCALE_MAP[normalizeLang(lang) || DEFAULT_LANG] || LOCALE_MAP[DEFAULT_LANG];
}

function formatMessage(message, params = {}) {
  if (!message || typeof message !== 'string') return message;

  return message.replace(/\{(\w+)}/g, (_, key) => {
    const value = params[key];
    return value == null ? `{${key}}` : String(value);
  });
}

function translateKey(key, lang = getLang()) {
  if (!key) return '';

  const normalizedLang = normalizeLang(lang) || DEFAULT_LANG;
  return TRANSLATIONS[normalizedLang]?.[key]
    || TRANSLATIONS[DEFAULT_LANG]?.[key]
    || TRANSLATIONS.en?.[key]
    || key;
}

function t(key, params = {}, options = {}) {
  const lang = typeof options === 'string' ? options : options.lang;
  return formatMessage(translateKey(key, lang), params);
}

function parseI18nParams(raw) {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function applyTranslationList(root, selector, callback) {
  root.querySelectorAll(selector).forEach((el) => {
    const key = el.getAttribute(selector.slice(1, -1));
    callback(el, t(key, parseI18nParams(el.getAttribute('data-i18n-params'))));
  });
}

function syncDocumentLang(lang = getLang()) {
  document.documentElement.lang = lang;
}

function syncLanguageButtons(root = document) {
  const lang = getLang();

  root.querySelectorAll('[data-set-lang], [data-lang]').forEach((el) => {
    const targetLang = normalizeLang(el.getAttribute('data-set-lang') || el.getAttribute('data-lang'));
    const isActive = targetLang === lang;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-pressed', String(isActive));
  });

  const dataAttrButtons = root.querySelectorAll('[data-set-lang], [data-lang]');
  if (!dataAttrButtons.length) {
    const fallbackButtons = root.querySelectorAll('.lang-switcher button');
    if (fallbackButtons.length) {
      const orderedLangs = ['en', 'de', 'es', 'fr'];
      fallbackButtons.forEach((btn, index) => {
        const isActive = orderedLangs[index] === lang;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
      });
    }
  }
}

function handleLanguageSwitcherClick(event) {
  const trigger = event.target.closest('[data-set-lang], [data-lang]');
  if (!trigger) return;

  const nextLang = trigger.getAttribute('data-set-lang') || trigger.getAttribute('data-lang');
  const normalized = normalizeLang(nextLang);
  if (!normalized || normalized === getLang()) return;

  setLang(normalized);
}

function bindLanguageSwitcher() {
  if (hasBoundLanguageSwitcher) return;

  document.addEventListener('click', handleLanguageSwitcherClick);
  hasBoundLanguageSwitcher = true;
}

function applyTranslations(root = document) {
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;

  syncDocumentLang();

  applyTranslationList(scope, '[data-i18n]', (el, value) => {
    el.textContent = value;
  });

  applyTranslationList(scope, '[data-i18n-placeholder]', (el, value) => {
    el.setAttribute('placeholder', value);
  });

  applyTranslationList(scope, '[data-i18n-aria-label]', (el, value) => {
    el.setAttribute('aria-label', value);
  });

  applyTranslationList(scope, '[data-i18n-title]', (el, value) => {
    el.setAttribute('title', value);
  });

  applyTranslationList(scope, '[data-i18n-content]', (el, value) => {
    el.setAttribute('content', value);
  });

  applyTranslationList(scope, '[data-i18n-value]', (el, value) => {
    el.setAttribute('value', value);
  });

  syncLanguageButtons(scope);
  return scope;
}

function setLang(lang, options = {}) {
  const normalized = normalizeLang(lang) || DEFAULT_LANG;
  const { persist = true, reload = false } = options;

  currentLang = normalized;

  if (persist) {
    safeStorageSet(STORAGE_KEY, normalized);
  }

  applyTranslations();

  document.dispatchEvent(new CustomEvent('i18n:change', {
    detail: {
      lang: normalized,
      locale: getLocale(normalized),
    },
  }));

  if (reload) {
    window.location.reload();
  }

  return normalized;
}

function initI18n() {
  currentLang = resolveInitialLang();
  bindLanguageSwitcher();
  applyTranslations();
}

window.t = t;
window.setLang = setLang;
window.getLang = getLang;
window.getLocale = getLocale;
window.getLangLocale = getLocale;
window.applyTranslations = applyTranslations;
window.i18n = Object.freeze({
  DEFAULT_LANG,
  LOCALE_MAP,
  SUPPORTED_LANGS,
  TRANSLATIONS,
  applyTranslations,
  getLang,
  getLocale,
  setLang,
  t,
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initI18n, { once: true });
} else {
  initI18n();
}

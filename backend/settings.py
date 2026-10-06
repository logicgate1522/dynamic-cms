"""
Django settings for backend project.
Production-ready with environment variables.
Combined from both settings files with proper organization.
"""

import os
from pathlib import Path
from django.core.exceptions import ImproperlyConfigured
import dj_database_url
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent

# ==================== SECURITY ====================

# SECURITY WARNING: don't run with debug turned on in production!
# Defaults to False on purpose: production must opt IN to debug mode, never
# opt out of it by forgetting to set the env var.
DEBUG = os.getenv('DEBUG', 'False') == 'True'

# SECURITY WARNING: keep the secret key used in production secret!
# A fallback dev-only key is allowed when DEBUG is on; production must
# always supply SECRET_KEY via the environment.
if DEBUG:
    SECRET_KEY = os.getenv('SECRET_KEY', 'django-insecure-dev-only-key-do-not-use-in-production')
else:
    SECRET_KEY = os.environ['SECRET_KEY']

# Parse ALLOWED_HOSTS from environment variable. Production deployments
# must set ALLOWED_HOSTS explicitly — the default here is dev-only.
ALLOWED_HOSTS_STR = os.getenv('ALLOWED_HOSTS', 'localhost,127.0.0.1')
ALLOWED_HOSTS = [host.strip() for host in ALLOWED_HOSTS_STR.split(',') if host.strip()]

# Security settings for production
SECURE_SSL_REDIRECT = os.getenv('SECURE_SSL_REDIRECT', 'False') == 'True'
SECURE_HSTS_SECONDS = int(os.getenv('SECURE_HSTS_SECONDS', '0'))
SECURE_HSTS_INCLUDE_SUBDOMAINS = os.getenv('SECURE_HSTS_INCLUDE_SUBDOMAINS', 'False') == 'True'
SECURE_HSTS_PRELOAD = os.getenv('SECURE_HSTS_PRELOAD', 'False') == 'True'
SESSION_COOKIE_SECURE = os.getenv('SESSION_COOKIE_SECURE', 'False') == 'True'
CSRF_COOKIE_SECURE = os.getenv('CSRF_COOKIE_SECURE', 'False') == 'True'

# Always-on hardening — these have no dev downside so they are not env-gated.
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'same-origin'
X_FRAME_OPTIONS = 'DENY'

# Behind a TLS-terminating proxy (Heroku/Railway/Nginx), let Django know the
# original request was HTTPS so SECURE_SSL_REDIRECT and secure-cookie logic
# behave. Only trusted when the env var is set — never assume a proxy.
if os.getenv('SECURE_PROXY_SSL_HEADER', 'False') == 'True':
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')

# ==================== APPLICATION DEFINITION ====================

INSTALLED_APPS = [
    # Django core apps
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',

    # Third-party apps
    'rest_framework',
    'rest_framework.authtoken',
    'corsheaders',
    'django_filters',

    # Local apps
    'api',  # the entire backend: content, SEO, blog, forms, images, and auth (CustomUser)
]

# ==================== CORS & CSRF ====================

# CORS Settings
CORS_ALLOWED_ORIGINS_STR = os.getenv('CORS_ALLOWED_ORIGINS', 'http://localhost:3000,http://127.0.0.1:3000')
CORS_ALLOWED_ORIGINS = [origin.strip() for origin in CORS_ALLOWED_ORIGINS_STR.split(',') if origin.strip()]

# Allow all origins in development only. Since DEBUG now defaults to False,
# this can no longer silently open up in production via a forgotten env var.
if DEBUG:
    CORS_ALLOW_ALL_ORIGINS = True

# CSRF Settings
CSRF_TRUSTED_ORIGINS_STR = os.getenv('CSRF_TRUSTED_ORIGINS', 'http://localhost:3000,http://127.0.0.1:3000')
CSRF_TRUSTED_ORIGINS = [origin.strip() for origin in CSRF_TRUSTED_ORIGINS_STR.split(',') if origin.strip()]

CORS_ALLOW_CREDENTIALS = True

# Additional CORS headers for your specific needs
CORS_ALLOW_HEADERS = [
    'accept',
    'accept-encoding',
    'authorization',
    'content-type',
    'dnt',
    'origin',
    'user-agent',
    'x-csrftoken',
    'x-requested-with',
    'x-store-slug',
    'x-user-type',
]

CORS_ALLOW_METHODS = [
    'DELETE',
    'GET',
    'OPTIONS',
    'PATCH',
    'POST',
    'PUT',
]

FRONTEND_URL = os.getenv('FRONTEND_URL', 'http://localhost:3000')

# Cache-refresh webhook (api/revalidation.py): every content write POSTs the
# affected cache tags here, HMAC-signed with REVALIDATE_SECRET. The frontend
# verifies the signature with the same secret. Empty URL = disabled.
FRONTEND_REVALIDATE_URL = os.getenv('FRONTEND_REVALIDATE_URL', '')
REVALIDATE_SECRET = os.getenv('REVALIDATE_SECRET', '')

# ==================== MIDDLEWARE ====================

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',  # For static files
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'backend.urls'

# ==================== TEMPLATES ====================

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'backend.wsgi.application'

# ==================== DATABASE ====================

# Database configuration
if os.getenv('DATABASE_URL'):
    # Use DATABASE_URL if provided (for Heroku, Railway, etc.)
    DATABASES = {
        'default': dj_database_url.config(
            default=os.getenv('DATABASE_URL'),
            conn_max_age=600,
            conn_health_checks=True,
        )
    }
else:
    # Use SQLite for development, PostgreSQL for production
    if DEBUG:
        DATABASES = {
            'default': {
                'ENGINE': 'django.db.backends.sqlite3',
                'NAME': BASE_DIR / 'db.sqlite3',
            }
        }
    else:
        DATABASES = {
            'default': {
                'ENGINE': 'django.db.backends.postgresql',
                'NAME': os.getenv('POSTGRES_DB', 'app'),
                'USER': os.getenv('POSTGRES_USER', 'app'),
                'PASSWORD': os.getenv('POSTGRES_PASSWORD', ''),
                'HOST': os.getenv('POSTGRES_HOST', 'localhost'),
                'PORT': os.getenv('POSTGRES_PORT', '5432'),
                'CONN_MAX_AGE': 600,  # Persistent connections
                'OPTIONS': {
                    'sslmode': os.getenv('POSTGRES_SSLMODE', 'prefer'),
                }
            }
        }

# ==================== PASSWORD VALIDATION ====================

AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]

# ==================== INTERNATIONALIZATION ====================

LANGUAGE_CODE = 'en-us'
TIME_ZONE = os.getenv('TIME_ZONE', 'UTC')
USE_I18N = True
USE_TZ = True

# ==================== STATIC & MEDIA FILES ====================

# Static files (CSS, JavaScript, Images)
STATIC_URL = '/static/'
STATIC_ROOT = os.path.join(BASE_DIR, 'staticfiles')
STATICFILES_DIRS = [
    os.path.join(BASE_DIR, 'static'),
]

# Media files (User uploaded files)
MEDIA_URL = '/media/'
MEDIA_ROOT = os.path.join(BASE_DIR, 'media')

# Ensure media directory exists
os.makedirs(MEDIA_ROOT, exist_ok=True)

# WhiteNoise for static files in production
if not DEBUG:
    STATICFILES_STORAGE = 'whitenoise.storage.CompressedManifestStaticFilesStorage'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ==================== AUTHENTICATION ====================

AUTH_USER_MODEL = 'api.CustomUser'

# ==================== REST FRAMEWORK ====================

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework.authentication.TokenAuthentication',
        'rest_framework.authentication.SessionAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticatedOrReadOnly',
    ],
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': int(os.getenv('PAGE_SIZE', '20')),
    'DEFAULT_FILTER_BACKENDS': [
        'django_filters.rest_framework.DjangoFilterBackend',
        'rest_framework.filters.SearchFilter',
        'rest_framework.filters.OrderingFilter',
    ],
    'DEFAULT_RENDERER_CLASSES': [
        'rest_framework.renderers.JSONRenderer',
    ],
    # We ship only the JSON renderer, so DRF's ?format= content-negotiation
    # override is useless — and it collides with endpoints that take a
    # ?format=csv|json app-level param (form-submission export). Disable it.
    'URL_FORMAT_OVERRIDE': None,
    'DEFAULT_THROTTLE_CLASSES': [
        'rest_framework.throttling.AnonRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
        # ScopedRateThrottle must be in the default list for any view that
        # sets `throttle_scope` to actually be rate-limited. It is a no-op
        # for views without a scope, so adding it here is safe globally.
        'rest_framework.throttling.ScopedRateThrottle',
    ],
    'DEFAULT_THROTTLE_RATES': {
        'anon': os.getenv('THROTTLE_RATE_ANON', '120/minute'),
        'user': os.getenv('THROTTLE_RATE_USER', '300/minute'),
        # Public, unauthenticated write endpoints (form submissions, inquiries)
        # get a much tighter rate on top of the anon default above.
        'form_submit': os.getenv('THROTTLE_RATE_FORM_SUBMIT', '5/minute'),
        # Admin login — brute-force resistance independent of form_submit.
        'login': os.getenv('THROTTLE_RATE_LOGIN', '10/minute'),
        # Public cached resolver endpoints (seo/resolve, redirects/resolve).
        'resolve': os.getenv('THROTTLE_RATE_RESOLVE', '60/minute'),
    },
}

# ==================== LOGGING ====================

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '{levelname} {asctime} {module} {process:d} {thread:d} {message}',
            'style': '{',
        },
        'simple': {
            'format': '{levelname} {message}',
            'style': '{',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'formatter': 'simple',
        },
        'file': {
            'class': 'logging.FileHandler',
            'filename': os.path.join(BASE_DIR, 'logs/django.log'),
            'formatter': 'verbose',
        },
    },
    'root': {
        'handlers': ['console'],
        'level': os.getenv('DJANGO_LOG_LEVEL', 'INFO'),
    },
    'loggers': {
        'django': {
            'handlers': ['console', 'file'],
            'level': os.getenv('DJANGO_LOG_LEVEL', 'INFO'),
            'propagate': False,
        },
        'django.db.backends': {
            'level': 'ERROR',
            'handlers': ['console'],
            'propagate': False,
        },
    },
}

# Ensure logs directory exists
os.makedirs(os.path.join(BASE_DIR, 'logs'), exist_ok=True)

# ==================== EMAIL ====================

EMAIL_BACKEND = os.getenv('EMAIL_BACKEND', 'django.core.mail.backends.console.EmailBackend')
EMAIL_HOST = os.getenv('EMAIL_HOST', '')
EMAIL_PORT = int(os.getenv('EMAIL_PORT', '587'))
EMAIL_USE_TLS = os.getenv('EMAIL_USE_TLS', 'True') == 'True'
EMAIL_HOST_USER = os.getenv('EMAIL_HOST_USER', '')
EMAIL_HOST_PASSWORD = os.getenv('EMAIL_HOST_PASSWORD', '')
DEFAULT_FROM_EMAIL = os.getenv('DEFAULT_FROM_EMAIL', 'noreply@example.com')

# Where new FormSubmission entries (bookings, contact forms, etc.) get
# emailed to. Empty by default — notification is skipped, not an error,
# so this backend still works with zero email config out of the box.
FORM_NOTIFICATION_EMAIL = os.getenv('FORM_NOTIFICATION_EMAIL', '')

# ==================== CACHE ====================

# Used by DRF's throttling (login, form submissions) among other things.
# Keyed on whether REDIS_URL is actually configured, not on DEBUG — a
# production deploy with no Redis infrastructure yet still works correctly
# via LocMemCache (single-process caveat: throttle counts aren't shared
# across gunicorn workers, so effective rate limits are looser than
# configured under multiple workers). Set REDIS_URL to get real shared
# caching once you have Redis available.
REDIS_URL = os.getenv('REDIS_URL', '')

if REDIS_URL:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.redis.RedisCache',
            'LOCATION': REDIS_URL,
        }
    }
else:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
        }
    }

# ==================== SECURE COOKIE SETTINGS ====================

SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_SAMESITE = 'Lax'
# The CSRF secret lives in the server-side session; the browser admin UI gets
# its masked token from GET auth/csrf/ (api/auth_views.py), since a frontend on
# another subdomain cannot read the API's cookies.
CSRF_USE_SESSIONS = True
SESSION_COOKIE_AGE = int(os.getenv('SESSION_COOKIE_AGE', str(60 * 60 * 12)))

# For production, use Strict. That works when the API is on the same site as
# the frontend (api.example.com + www.example.com). For an API on a different
# registrable domain, set SESSION_COOKIE_SAMESITE=None (requires HTTPS and
# SESSION_COOKIE_SECURE=True).
if not DEBUG:
    SESSION_COOKIE_SAMESITE = 'Strict'
    CSRF_COOKIE_SAMESITE = 'Strict'
_samesite_override = os.getenv('SESSION_COOKIE_SAMESITE', '').strip()
if _samesite_override:
    if _samesite_override not in ('Lax', 'Strict', 'None'):
        raise ImproperlyConfigured("SESSION_COOKIE_SAMESITE must be Lax, Strict or None.")
    if _samesite_override == 'None' and not SESSION_COOKIE_SECURE:
        raise ImproperlyConfigured("SESSION_COOKIE_SAMESITE=None requires SESSION_COOKIE_SECURE=True.")
    SESSION_COOKIE_SAMESITE = CSRF_COOKIE_SAMESITE = _samesite_override

# ==================== APP SPECIFIC SETTINGS ====================

# Max file upload size (10MB)
MAX_UPLOAD_SIZE = 10485760  # 10 MB in bytes

# Image upload guard rails (api.image_validation).
MAX_IMAGE_BYTES = int(os.getenv('MAX_IMAGE_BYTES', str(10 * 1024 * 1024)))
MAX_IMAGE_DIMENSION = int(os.getenv('MAX_IMAGE_DIMENSION', '12000'))
# SVGs are an executable/script vector (embedded <script>, foreignObject).
# Off by default; a project that genuinely needs SVG logos opts in.
ALLOW_SVG_UPLOAD = os.getenv('ALLOW_SVG_UPLOAD', 'False') == 'True'
# Re-encode raster uploads to WebP (api/image_optimize.py) when it saves bytes.
IMAGE_OPTIMIZE = os.getenv('IMAGE_OPTIMIZE', 'True') == 'True'
IMAGE_OPTIMIZE_MAX_DIMENSION = int(os.getenv('IMAGE_OPTIMIZE_MAX_DIMENSION', '2400'))
IMAGE_OPTIMIZE_WEBP_QUALITY = int(os.getenv('IMAGE_OPTIMIZE_WEBP_QUALITY', '82'))

# API Version
API_VERSION = 'v1'

# Extra sitemap content sources for a cloned project. Each entry is
# "module.path:callable"; the callable returns dicts with path/changefreq/
# priority/lastmod. "pages" and "blog" are always included. Example:
#   SITEMAP_SOURCES = ['myproject.sitemaps:products']
SITEMAP_SOURCES = [
    s.strip() for s in os.getenv('SITEMAP_SOURCES', '').split(',') if s.strip()
]



# project/urls.py

from django.contrib import admin
from django.urls import path, re_path, include
from django.conf import settings
from django.conf.urls.static import static

from api.sitemaps import (
    robots_txt,
    sitemap_all,
    sitemap_index,
    sitemap_section,
)


urlpatterns = [
    path('admin/', admin.site.urls),

    # SEO discovery files — deliberately at the site root, not under /api/.
    path('robots.txt', robots_txt, name='robots-txt'),
    path('sitemap.xml', sitemap_all, name='sitemap'),
    path('sitemap-index.xml', sitemap_index, name='sitemap-index'),
    re_path(r'^sitemap-(?P<section>[\w-]+)\.xml$', sitemap_section, name='sitemap-section'),

    # Mount all API routes under /api/ — the entire backend, including
    # admin login (api/auth/login/), lives in the one portable `api` app.
    path('api/', include('api.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

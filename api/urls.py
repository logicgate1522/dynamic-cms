# api/urls.py

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    AdminLoginView,
    BlogPostViewSet,
    ComponentDataView,
    ComponentHistoryView,
    ComponentPublishView,
    ComponentRevertView,
    ComponentSchemaListView,
    FormSubmissionListView,
    FormSubmitView,
    OrganizationSchemaView,
    PageSEODetailView,
    PageSEOHistoryView,
    PageSEOListView,
    PageSEORevertView,
    SEOResolveView,
    RedirectViewSet,
    RetrieveImage,
    SiteSettingsView,
    UploadedImageViewSet,
)

router = DefaultRouter()
router.register(r'blog', BlogPostViewSet, basename='blog')
router.register(r'redirects', RedirectViewSet, basename='redirect')

urlpatterns = [
    path('auth/login/', AdminLoginView.as_view(), name='admin-login'),

    # Generic inline-editable ("CMS") sections — e.g. home/footer/, home/hero/.
    # Specific sub-routes MUST precede the greedy <slug:name> catch-all.
    path('home/schemas/', ComponentSchemaListView.as_view(), name='component-schemas'),
    path('home/<slug:name>/history/', ComponentHistoryView.as_view(), name='component-history'),
    path('home/<slug:name>/publish/', ComponentPublishView.as_view(), name='component-publish'),
    path('home/<slug:name>/revert/<int:revision_id>/', ComponentRevertView.as_view(), name='component-revert'),
    path('home/<slug:name>/', ComponentDataView.as_view(), name='home-component'),

    path('images/', UploadedImageViewSet.as_view(), name='image-list-create'),
    path('images/<int:pk>/', RetrieveImage.as_view(), name='image-retrieve'),

    path('settings/site/schema/organization/', OrganizationSchemaView.as_view(), name='site-org-schema'),
    path('settings/site/', SiteSettingsView.as_view(), name='site-settings'),

    path('seo/', PageSEOListView.as_view(), name='seo-list'),
    # Specific routes MUST precede the greedy seo/<path:path>/ catch-all —
    # otherwise <path:path> swallows ".../history/", "resolve/...", etc.
    path('seo/resolve/<path:path>/', SEOResolveView.as_view(), name='seo-resolve'),
    path('seo/<path:path>/history/', PageSEOHistoryView.as_view(), name='seo-history'),
    path('seo/<path:path>/revert/<int:history_id>/', PageSEORevertView.as_view(), name='seo-revert'),
    path('seo/<path:path>/', PageSEODetailView.as_view(), name='seo-detail'),

    path('forms/<slug:name>/submit/', FormSubmitView.as_view(), name='form-submit'),
    path('forms/<slug:name>/submissions/', FormSubmissionListView.as_view(), name='form-submissions'),

    path('', include(router.urls)),
]

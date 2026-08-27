# api/urls.py

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .section_views import (
    BlogSectionDetailView,
    BlogSectionListView,
    BlogSectionMediaUploadView,
    BlogSectionReorderView,
    ContentPageDetailView,
    ContentPageListCreateView,
    CopyStructurePromptView,
    DynamicPagePromptView,
    PasteToBuildView,
    SectionDetailView,
    SectionListView,
    SectionMediaUploadView,
    SectionReorderView,
    SectionSchemaView,
)
from .views import (
    AdminLoginView,
    BlogPostViewSet,
    ComponentDataView,
    ComponentHistoryView,
    ComponentPublishView,
    ComponentRevertView,
    ComponentSchemaListView,
    FormSubmissionDetailView,
    FormSubmissionExportView,
    FormSubmissionListView,
    FormSubmitView,
    OrganizationSchemaView,
    RedirectImportExportView,
    RedirectResolveView,
    PageSEODetailView,
    PageSEOHistoryView,
    PageSEOListView,
    PageSEORevertView,
    SchemaValidateView,
    SEOAuditRollupView,
    SEOAuditView,
    SEOResolveView,
    RedirectViewSet,
    ImageUsageView,
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
    path('images/<int:pk>/usage/', ImageUsageView.as_view(), name='image-usage'),
    path('images/<int:pk>/', RetrieveImage.as_view(), name='image-retrieve'),

    path('settings/site/schema/organization/', OrganizationSchemaView.as_view(), name='site-org-schema'),
    path('settings/site/', SiteSettingsView.as_view(), name='site-settings'),

    path('seo/', PageSEOListView.as_view(), name='seo-list'),
    # Specific routes MUST precede the greedy seo/<path:path>/ catch-all —
    # otherwise <path:path> swallows ".../history/", "resolve/...", etc.
    path('seo/resolve/<path:path>/', SEOResolveView.as_view(), name='seo-resolve'),
    path('seo/validate-schema/', SchemaValidateView.as_view(), name='seo-validate-schema'),
    path('seo/analyze/', SEOAuditRollupView.as_view(), name='seo-audit-rollup'),
    path('seo/analyze/<path:path>/', SEOAuditView.as_view(), name='seo-audit'),
    path('seo/<path:path>/history/', PageSEOHistoryView.as_view(), name='seo-history'),
    path('seo/<path:path>/revert/<int:history_id>/', PageSEORevertView.as_view(), name='seo-revert'),
    path('seo/<path:path>/', PageSEODetailView.as_view(), name='seo-detail'),

    # ---- Dynamic Page / Section system ----
    path('ai/section-schema/', SectionSchemaView.as_view(), name='section-schema'),
    path('ai/dynamic-page-prompt/', DynamicPagePromptView.as_view(), name='dynamic-page-prompt'),
    path('ai/copy-structure-prompt/', CopyStructurePromptView.as_view(), name='copy-structure-prompt'),
    path('content/paste-to-build/', PasteToBuildView.as_view(), name='paste-to-build'),
    path('content/pages/', ContentPageListCreateView.as_view(), name='content-page-list'),
    path('content/pages/<path:path>/', ContentPageDetailView.as_view(), name='content-page-detail'),
    path('content/<path:key>/sections/reorder/', SectionReorderView.as_view(), name='content-section-reorder'),
    path('content/<path:key>/sections/<int:pk>/media/<str:slot>/', SectionMediaUploadView.as_view(), name='content-section-media'),
    path('content/<path:key>/sections/<int:pk>/', SectionDetailView.as_view(), name='content-section-detail'),
    path('content/<path:key>/sections/', SectionListView.as_view(), name='content-section-list'),
    path('blog/<slug:key>/sections/reorder/', BlogSectionReorderView.as_view(), name='blog-section-reorder'),
    path('blog/<slug:key>/sections/<int:pk>/media/<str:slot>/', BlogSectionMediaUploadView.as_view(), name='blog-section-media'),
    path('blog/<slug:key>/sections/<int:pk>/', BlogSectionDetailView.as_view(), name='blog-section-detail'),
    path('blog/<slug:key>/sections/', BlogSectionListView.as_view(), name='blog-section-list'),

    path('forms/<slug:name>/submit/', FormSubmitView.as_view(), name='form-submit'),
    path('forms/<slug:name>/submissions/export/', FormSubmissionExportView.as_view(), name='form-submissions-export'),
    path('forms/<slug:name>/submissions/<int:pk>/', FormSubmissionDetailView.as_view(), name='form-submission-detail'),
    path('forms/<slug:name>/submissions/', FormSubmissionListView.as_view(), name='form-submissions'),

    path('redirects/resolve/', RedirectResolveView.as_view(), name='redirect-resolve'),
    path('redirects/io/', RedirectImportExportView.as_view(), name='redirect-io'),

    path('', include(router.urls)),
]

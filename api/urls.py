# api/urls.py

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .collection_views import (
    CollectionEntriesView,
    CollectionEntryApplyView,
    CollectionEntryDetailView,
    CollectionEntryPromptView,
    CollectionForPathView,
    CollectionListView,
    CollectionPromptView,
    LaunchCheckView,
)
from .ai_views import (
    BlogBuildPromptView,
    BuildPromptView,
    KeywordPromptView,
    NewPagePromptView,
    NormalizeView,
    PageAssistPromptView,
    SectionPromptView,
    SeoPromptView,
)
from .section_views import (
    BlogPasteToEditView,
    BlogSectionAddView,
    BlogSectionDetailView,
    BlogSectionListView,
    BlogSectionMediaUploadView,
    BlogSectionReorderView,
    ContentPageDetailView,
    ContentPageListCreateView,
    CopyStructurePromptView,
    DynamicPagePromptView,
    PasteToBuildView,
    PasteToEditView,
    SectionAddView,
    SectionDetailView,
    SectionListView,
    SectionMediaUploadView,
    SectionReorderView,
    SectionSchemaView,
)
from .auth_views import CsrfTokenView, LogoutView, SessionStatusView
from .sitemaps import SitemapReportView
from .draft_views import DraftDiscardView, DraftListView, DraftPublishView
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
    path('auth/csrf/', CsrfTokenView.as_view(), name='auth-csrf'),
    path('auth/session/', SessionStatusView.as_view(), name='auth-session'),
    path('auth/logout/', LogoutView.as_view(), name='auth-logout'),
    path('drafts/', DraftListView.as_view(), name='drafts'),
    path('sitemap/report/', SitemapReportView.as_view(), name='sitemap-report'),
    path('drafts/publish/', DraftPublishView.as_view(), name='drafts-publish'),
    path('drafts/discard/', DraftDiscardView.as_view(), name='drafts-discard'),
    path('launch-check/', LaunchCheckView.as_view(), name='launch-check'),
    path('collections/', CollectionListView.as_view(), name='collections'),
    path('collections/for-path/', CollectionForPathView.as_view(), name='collection-for-path'),
    path('collections/<slug:key>/prompt/', CollectionPromptView.as_view(), name='collection-prompt'),
    path('collections/<slug:key>/entries/', CollectionEntriesView.as_view(), name='collection-entries'),
    path('collections/<slug:key>/entries/<slug:slug>/prompt/', CollectionEntryPromptView.as_view(), name='collection-entry-prompt'),
    path('collections/<slug:key>/entries/<slug:slug>/apply/', CollectionEntryApplyView.as_view(), name='collection-entry-apply'),
    path('collections/<slug:key>/entries/<slug:slug>/', CollectionEntryDetailView.as_view(), name='collection-entry'),

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
    path('seo/resolve/', SEOResolveView.as_view(), name='seo-resolve-home'),
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
    path('ai/new-page-prompt/', NewPagePromptView.as_view(), name='ai-new-page-prompt'),
    path('ai/section-prompt/', SectionPromptView.as_view(), name='ai-section-prompt'),
    path('ai/page-assist-prompt/', PageAssistPromptView.as_view(), name='ai-page-assist-prompt'),
    path('ai/seo-prompt/', SeoPromptView.as_view(), name='ai-seo-prompt'),
    path('ai/keyword-prompt/', KeywordPromptView.as_view(), name='ai-keyword-prompt'),
    path('ai/normalize/', NormalizeView.as_view(), name='ai-normalize'),
    path('content/paste-to-build/', PasteToBuildView.as_view(), name='paste-to-build'),
    path('content/pages/', ContentPageListCreateView.as_view(), name='content-page-list'),
    path('content/pages/<path:path>/', ContentPageDetailView.as_view(), name='content-page-detail'),
    path('content/<path:key>/build-prompt/', BuildPromptView.as_view(), name='content-build-prompt'),
    path('content/<path:key>/paste-to-edit/', PasteToEditView.as_view(), name='content-paste-to-edit'),
    path('content/<path:key>/sections/add/', SectionAddView.as_view(), name='content-section-add'),
    path('content/<path:key>/sections/reorder/', SectionReorderView.as_view(), name='content-section-reorder'),
    path('content/<path:key>/sections/<int:pk>/media/<str:slot>/', SectionMediaUploadView.as_view(), name='content-section-media'),
    path('content/<path:key>/sections/<int:pk>/', SectionDetailView.as_view(), name='content-section-detail'),
    path('content/<path:key>/sections/', SectionListView.as_view(), name='content-section-list'),
    path('blog/<slug:key>/build-prompt/', BlogBuildPromptView.as_view(), name='blog-build-prompt'),
    path('blog/<slug:key>/paste-to-edit/', BlogPasteToEditView.as_view(), name='blog-paste-to-edit'),
    path('blog/<slug:key>/sections/add/', BlogSectionAddView.as_view(), name='blog-section-add'),
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

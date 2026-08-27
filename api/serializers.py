from rest_framework import serializers

from .image_validation import validate_upload
from .models import (
    BlogPost,
    ComponentRevision,
    ComponentSchema,
    FormSubmission,
    PageSEO,
    Redirect,
    UploadedImage,
)

MAX_REDIRECT_CHAIN_DEPTH = 20


class UploadedImageSerializer(serializers.ModelSerializer):
    image_url = serializers.SerializerMethodField()

    class Meta:
        model = UploadedImage
        fields = "__all__"

    def get_image_url(self, obj):
        """Always-absolute URL so the frontend never has to guess the origin."""
        if not obj.image:
            return None
        request = self.context.get("request")
        url = obj.image.url
        return request.build_absolute_uri(url) if request is not None else url

    def validate_image(self, value):
        validate_upload(value)
        return value

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data.setdefault("duplicate", False)
        return data


class BlogPostSerializer(serializers.ModelSerializer):
    class Meta:
        model = BlogPost
        fields = "__all__"


class PageSEOSerializer(serializers.ModelSerializer):
    class Meta:
        model = PageSEO
        fields = ["path", "data", "updated_at"]


class RedirectSerializer(serializers.ModelSerializer):
    effective_status = serializers.IntegerField(read_only=True)

    class Meta:
        model = Redirect
        fields = "__all__"
        read_only_fields = ["hit_count", "last_hit_at", "created_by", "created_at"]

    def validate(self, attrs):
        source = attrs.get("source", getattr(self.instance, "source", None))
        destination = attrs.get("destination", getattr(self.instance, "destination", None))

        if source == destination:
            raise serializers.ValidationError("A redirect cannot point to itself.")

        # Walk the chain starting at `destination`: if it ever leads back to
        # `source`, saving this redirect would create a loop. Bounded depth
        # so a pre-existing bad chain can't hang validation.
        current = destination
        for _ in range(MAX_REDIRECT_CHAIN_DEPTH):
            next_hop = (
                Redirect.objects.filter(source=current)
                .exclude(pk=getattr(self.instance, "pk", None))
                .values_list("destination", flat=True)
                .first()
            )
            if next_hop is None:
                break
            if next_hop == source:
                raise serializers.ValidationError(
                    "This redirect would create a loop with an existing redirect chain."
                )
            current = next_hop
        else:
            raise serializers.ValidationError(
                f"Redirect chain from this destination is longer than {MAX_REDIRECT_CHAIN_DEPTH} hops — refusing to save."
            )

        return attrs


class ComponentRevisionSerializer(serializers.ModelSerializer):
    saved_by = serializers.StringRelatedField()

    class Meta:
        model = ComponentRevision
        fields = ["id", "data", "saved_by", "note", "created_at"]


class ComponentSchemaSerializer(serializers.ModelSerializer):
    class Meta:
        model = ComponentSchema
        fields = ["key", "label", "schema", "builtin", "updated_at"]


class FormSubmissionSerializer(serializers.ModelSerializer):
    class Meta:
        model = FormSubmission
        fields = "__all__"
        read_only_fields = ["created_at"]

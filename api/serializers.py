from rest_framework import serializers

from .models import BlogPost, FormSubmission, PageSEO, Redirect, UploadedImage

MAX_REDIRECT_CHAIN_DEPTH = 20


class UploadedImageSerializer(serializers.ModelSerializer):
    class Meta:
        model = UploadedImage
        fields = "__all__"


class BlogPostSerializer(serializers.ModelSerializer):
    class Meta:
        model = BlogPost
        fields = "__all__"


class PageSEOSerializer(serializers.ModelSerializer):
    class Meta:
        model = PageSEO
        fields = ["path", "data", "updated_at"]


class RedirectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Redirect
        fields = "__all__"

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


class FormSubmissionSerializer(serializers.ModelSerializer):
    class Meta:
        model = FormSubmission
        fields = "__all__"
        read_only_fields = ["created_at"]

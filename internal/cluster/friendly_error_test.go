package cluster

import (
	"errors"
	"strings"
	"testing"
)

func TestFriendlyErrorMessageRecognisesAWSCLIMissing(t *testing.T) {
	got := FriendlyErrorMessage(errors.New(`getting credentials: exec: "aws": executable file not found in $PATH`))
	if got != msgAWSCLIMissing {
		t.Fatalf("got %q, want %q", got, msgAWSCLIMissing)
	}
}

func TestFriendlyErrorMessageRecognisesExpiredAWSSession(t *testing.T) {
	got := FriendlyErrorMessage(errors.New("exec plugin: aws sso token has expired"))
	if got != msgAWSSessionExpired {
		t.Fatalf("got %q, want %q", got, msgAWSSessionExpired)
	}
}

func TestFriendlyErrorMessageLeavesGenericUnauthorizedAlone(t *testing.T) {
	err := errors.New("the server has asked for the client to provide credentials: Unauthorized")
	got := FriendlyErrorMessage(err)
	if got != err.Error() {
		t.Fatalf("generic auth error should not become AWS-specific: %q", got)
	}
}

func TestFriendlyErrorMessageLabelsUnknownExecPluginFailure(t *testing.T) {
	got := FriendlyErrorMessage(errors.New("getting credentials: exec plugin failed with exit code 1"))
	if !strings.HasPrefix(got, msgCredentialExecError) {
		t.Fatalf("got %q", got)
	}
}

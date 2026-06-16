package cluster

import (
	"errors"
	"strings"
)

const (
	msgAWSCLIMissing       = "AWS CLI not found - install AWS CLI v2 or ensure aws is on PATH for EKS authentication"
	msgAWSSessionExpired   = "AWS auth expired - run aws sso login for the profile used by this kubeconfig"
	msgAWSCredsMissing     = "AWS credentials not found - configure AWS credentials or run aws sso login for the profile used by this kubeconfig"
	msgAWSAccessDenied     = "AWS access denied - check the profile or role used by this kubeconfig"
	msgKubeloginMissing    = "kubelogin not found - install kubelogin or ensure it is on PATH for AKS authentication"
	msgCredentialExecError = "credential exec plugin failed"
)

// FriendlyErrorMessage turns common kubeconfig exec-plugin failures into
// operator-facing wording. The raw error remains useful to logs, but Fleet cards
// need the next action more than an implementation stack.
func FriendlyErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	lower := strings.ToLower(msg)

	switch {
	case containsAny(lower,
		`exec: "aws": executable file not found`,
		"executable aws not found",
		"aws: executable file not found",
		"aws: command not found",
		"aws.exe: executable file not found",
	):
		return msgAWSCLIMissing
	case containsAny(lower,
		`exec: "kubelogin": executable file not found`,
		"executable kubelogin not found",
		"kubelogin: executable file not found",
		"kubelogin: command not found",
	):
		return msgKubeloginMissing
	case containsAny(lower,
		"expiredtoken",
		"expired token",
		"security token included in the request is expired",
		"the token has expired",
		"invalid_grant",
	) || (strings.Contains(lower, "sso") && containsAny(lower, "expired", "session", "login")):
		return msgAWSSessionExpired
	case containsAny(lower,
		"nocredentialproviders",
		"unable to locate credentials",
		"could not find config for profile",
		"missing credentials",
	):
		return msgAWSCredsMissing
	case containsAny(lower,
		"accessdenied",
	):
		return msgAWSAccessDenied
	case strings.Contains(lower, "exec plugin") || strings.Contains(lower, "getting credentials"):
		return msgCredentialExecError + " - " + msg
	default:
		return msg
	}
}

func FriendlyError(err error) error {
	if err == nil {
		return nil
	}
	return errors.New(FriendlyErrorMessage(err))
}

func containsAny(s string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}

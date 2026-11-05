package httpapi

import (
	"os"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"github.com/bropines/jackett-ui/server/internal/auth"
)

// TestMain hashes passwords with the minimum bcrypt cost: the suite creates
// many users, and cost 12 makes it very slow under -race.
func TestMain(m *testing.M) {
	auth.HashCost = bcrypt.MinCost
	os.Exit(m.Run())
}

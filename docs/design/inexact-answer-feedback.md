# Feedback for inexact answers

When the user gets an answer wrong we go through a sequence to compute the best possible feedback.
Note that all feedback is in the user's native language.

## 1. Acceptable synonyms

- If the user's answer was an acceptable synonym, then tell the user the correct word and that they entered an acceptable synonym.
  then we should save the synonyms in the database going both ways. then when the user makes an inexact guess we check the user's guess against known synonyms. we should do this in the same place that we check for bad POS matches, but BEFORE we check for bad POS matches.

## 2. Unacceptable synonyms

- If the user entered a synonym but it's not the best word, we tell the user that

## 3. POS feedback

- Tell the user if they entered a word that doesn't match the POS of the target word. They can then try again. We can't give them credit for the word unless they type in the correct word!
